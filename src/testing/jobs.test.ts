import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, elapsed, endNote, lastLines } from "../jobs.ts";
import type { Job } from "../jobs.ts";
import { Agent } from "../loop.ts";
import { bashTool } from "../tools/bash.ts";
import type { Provider, StreamEvent } from "../types.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-jobs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function jobs(): { jobs: Jobs; ended: Job[] } {
  const ended: Job[] = [];
  return { jobs: new Jobs({ dir, onEnd: (job) => ended.push(job) }), ended };
}

describe("background jobs", () => {
  test("a job runs on its own: start returns at once; its end is told with its state, code and log", async () => {
    const { jobs: j, ended } = jobs();
    const at = Date.now();
    const job = j.start("echo one; sleep 0.2; echo two", dir);
    expect(Date.now() - at).toBeLessThan(100);
    expect(job).toMatchObject({ id: 1, state: "running" });
    expect(j.running).toBe(1);
    await j.ended(job.id);
    expect(ended[0]).toMatchObject({ id: 1, state: "done", code: 0 });
    expect(j.running).toBe(0);
    expect(j.tail(1, 5)).toEqual(["one", "two"]);
    await Bun.sleep(20); // the log's stream flushes
    expect(await Bun.file(job.log).text()).toBe("one\ntwo\n");
    if (process.platform !== "win32") expect(statSync(job.log).mode & 0o777).toBe(0o600); // no Unix modes on Windows
  });

  test("a failure says its exit code; stderr is kept too", async () => {
    const { jobs: j, ended } = jobs();
    const job = j.start("echo oops >&2; exit 3", dir);
    await j.ended(job.id);
    expect(ended[0]).toMatchObject({ state: "failed", code: 3 });
    expect(j.tail(job.id, 1)).toEqual(["oops"]);
  });

  test("kill stops the whole process group (a child of the shell too); killAll the rest", async () => {
    const { jobs: j, ended } = jobs();
    const a = j.start("sleep 30 & sleep 30; wait", dir);
    const b = j.start("sleep 30", dir);
    expect(j.kill(a.id)).toBe(true);
    expect(j.kill(a.id)).toBe(false); // not running any more
    await j.ended(a.id);
    expect(ended.find((x) => x.id === a.id)?.state).toBe("killed");
    j.killAll();
    await j.ended(b.id);
    expect(j.list().every((x) => x.state === "killed")).toBe(true);
  });

  test("a change (start, output, end) tells the listeners", async () => {
    const { jobs: j } = jobs();
    let changes = 0;
    const off = j.on(() => changes++);
    const job = j.start("echo x", dir);
    await j.ended(job.id);
    off();
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  test("lastLines: a progress bar's carriage returns keep its last state; colours and trailing blanks go", () => {
    expect(lastLines("a\n 10%\r 50%\r100%\n\x1b[32mok\x1b[0m\n\n", 5)).toEqual(["a", "100%", "ok"]);
    expect(lastLines("1\n2\n3\n4", 2)).toEqual(["3", "4"]);
  });

  test("the note the agent gets: how it ended, how long, its last lines, the log", () => {
    const job: Job = { id: 2, command: "make", cwd: dir, pid: 1, started: 0, ended: 192_000, state: "failed", code: 2, log: "/l/2.log" };
    expect(endNote(job, ["error: x"])).toBe("[kinoko] Background job #2 failed (exit 2) after 3m 12s: `make`\nLast lines:\n```\nerror: x\n```\nFull output: /l/2.log");
    expect(endNote({ ...job, state: "done", code: 0 }, [])).toContain("finished (exit 0) after 3m 12s: `make`\nIt printed nothing.");
    expect(elapsed(45_000)).toBe("45s");
    expect(elapsed(3_900_000)).toBe("1h 5m");
  });

  test("the loop: bash background: true starts a job in the run's cwd and the run goes on; its end wakes the idle agent", async () => {
    let turn = 0;
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        turn++;
        if (turn === 1) {
          yield { type: "tool_call", call: { id: "c", name: "bash", args: { command: "sleep 0.2; echo fetched", background: true } } };
          yield { type: "done", stop: "tool_use" };
          return;
        }
        yield { type: "text", delta: turn === 2 ? "started it" : "saw it end" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as Provider;
    const prompts: string[] = [];
    let agent: Agent | undefined;
    const j = new Jobs({ dir, onEnd: (job) => void agent?.prompt(endNote(job, j.tail(job.id, 5))) });
    agent = new Agent({ provider, model: "m", system: "", tools: [bashTool], maxTurns: 5, maxCost: 1, background: (command, cwd) => j.start(command, cwd) });
    agent.on((e) => e.type === "run_start" && prompts.push(e.prompt));
    const at = Date.now();
    expect((await agent.prompt("fetch it")).reason).toBe("done");
    expect(Date.now() - at).toBeLessThan(200); // nobody waited for the job
    expect(j.list()[0]).toMatchObject({ command: "sleep 0.2; echo fetched", cwd: process.cwd() });
    await j.ended(1);
    for (let i = 0; i < 100 && (prompts.length < 2 || agent.state !== "idle"); i++) {
      // oxlint-disable-next-line no-await-in-loop -- polling for the woken run to end
      await Bun.sleep(10);
    }
    expect(prompts[1]).toStartWith("[kinoko] Background job #1 finished (exit 0)");
    expect(prompts[1]).toContain("fetched");
    expect(agent.messages.at(-1)?.content).toBe("saw it end");
  });
});
