import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { Extensions } from "../../src/ext.ts";
import type { ProviderRequest } from "../../src/types.ts";
import install, { send } from "./herdr.ts";

// A fake herdr: takes JSON lines on a unix socket, answers each, keeps what it got.
const path = `${tmpdir()}/kinoko-herdr-${process.pid}.sock`;
const got: Array<{ method: string; params: Record<string, unknown> }> = [];
const server = createServer((conn) => {
  conn.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) got.push(JSON.parse(line));
    conn.write('{"result":{"type":"ok"}}\n');
  });
});
await new Promise<void>((ready) => server.listen(path, ready));
afterAll(() => server.close());

const req = {} as ProviderRequest;
const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "w1:p2" };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

function setup(environment: Record<string, string | undefined>): Extensions {
  const ext = new Extensions(() => {});
  install(ext, environment);
  return ext;
}

describe("herdr extension", () => {
  test("the TUI reports the pane as a kinoko agent: idle, working while a run lasts, idle again", async () => {
    got.length = 0;
    const ext = setup(env);
    ext.emit("session_start", { cwd: "/p", model: "m", mode: "tui" });
    ext.emit("before_provider_request", req);
    ext.emit("before_provider_request", req); // the next request of the same run: no new report
    ext.emit("run_end", { reason: "done" });
    await settle();
    expect(got.map((r) => r.params.state)).toEqual(["idle", "working", "idle"]);
    expect(got.every((r) => r.method === "pane.report_agent" && r.params.pane_id === "w1:p2" && r.params.agent === "kinoko")).toBe(true);
    const seqs = got.map((r) => r.params.seq as number);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b)); // newer reports carry larger numbers
  });

  test("print and rpc modes, or no herdr, report nothing", async () => {
    got.length = 0;
    const print = setup(env);
    print.emit("session_start", { cwd: "/p", model: "m", mode: "print" });
    print.emit("before_provider_request", req);
    const outside = setup({});
    outside.emit("session_start", { cwd: "/p", model: "m", mode: "tui" });
    await settle();
    expect(got).toEqual([]);
  });

  test("a herdr that is not there is no error", async () => {
    expect(await send(`${tmpdir()}/no-such-herdr.sock`, { method: "x" }, 200)).toBe(false);
  });
});
