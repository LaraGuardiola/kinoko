import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { Session, findSession, latestSession, sessionDir } from "./session.ts";
import { openaiCompat } from "./providers/openai-compat.ts";
import { Agent } from "./loop.ts";
import type { Message, ProviderRequest, StreamEvent, Usage } from "./types.ts";

const HOME = `${process.cwd()}/.tmp-session-test-${process.pid}`;
const CWD = `${HOME}/project`;

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Fake provider: one scripted turn per prompt, or a tool call that hangs until aborted. */
function fakeProvider(script: StreamEvent[][]): {
  provider: { stream: (req: ProviderRequest) => AsyncIterable<StreamEvent> };
  bodies: () => string[];
} {
  const bodies: string[] = [];
  let turn = 0;
  return {
    bodies: () => bodies,
    provider: {
      stream: async function* (req: ProviderRequest): AsyncIterable<StreamEvent> {
        bodies.push(JSON.stringify({ model: req.model, system: req.system, messages: req.messages }));
        const events = script[turn] ?? [{ type: "text", delta: "done" }, { type: "done", stop: "end" as const }];
        turn++;
        for (const ev of events) {
          if (req.signal.aborted) break;
          yield ev;
          // oxlint-disable-next-line no-await-in-loop -- the fake engine streams slowly on purpose
          if (ev.type === "text") await new Promise((r) => setTimeout(r, 1));
        }
      },
    },
  };
}

function agentWith(session: Session, provider: ReturnType<typeof fakeProvider>["provider"]): Agent {
  return new Agent({ provider, model: "t", system: "sys", tools: [], maxTurns: 5, maxCost: 10, session });
}

describe("session log", () => {
  test("1. every message gets id + parentId and the file stays append-only", async () => {
    rmSync(HOME, { recursive: true, force: true });
    const session = await Session.create({ cwd: CWD, model: "m", home: HOME });
    const a = await session.append({ id: "m1", role: "user", content: "one" });
    const b = await session.append({ id: "m2", role: "assistant", content: "two" });
    const c = await session.append({ id: "m3", role: "user", content: "three" });

    expect(a.parentId).toBeUndefined(); // nothing before it
    expect(b.parentId).toBe("m1");
    expect(c.parentId).toBe("m2");
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4); // session record + three messages, nothing rewritten
    expect(lines[0] && JSON.parse(lines[0]).type).toBe("session");
    expect(session.activeBranch().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("2. resume restores state; activeBranch follows the head pointer", async () => {
    const session = await Session.create({ cwd: CWD, model: "m", home: HOME });
    await session.append({ id: "m1", role: "user", content: "one" });
    await session.append({ id: "m2", role: "assistant", content: "two" });
    await session.append({ id: "m3", role: "user", content: "three" });

    const reloaded = await Session.load(session.path);
    expect(reloaded.view().map((m) => m.content)).toEqual(["one", "two", "three"]);
    expect(reloaded.meta.model).toBe("m");
    // Moving the head back is all a fork needs: the log itself is never touched.
    await reloaded.setHead("m2");
    const forked = await Session.load(session.path);
    expect(forked.activeBranch().map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("3. a resumed aborted run keeps every tool call paired with exactly one result", async () => {
    rmSync(HOME, { recursive: true, force: true });
    // Aborting inside the first tool cuts it off mid-run, so the second call never starts.
    let agent!: Agent;
    const tool = {
      name: "slow",
      description: "",
      schema: {},
      readOnly: false,
      run: async (_a: unknown, ctx: { signal: AbortSignal }) => {
        agent.abort();
        await new Promise<void>((r) => setTimeout(r, 5));
        if (ctx.signal.aborted) throw new Error("Aborted by user");
        return "result";
      },
    };
    const script: StreamEvent[][] = [
      [
        { type: "tool_call", call: { id: "c1", name: "slow", args: {} } },
        { type: "tool_call", call: { id: "c2", name: "slow", args: {} } },
        { type: "done", stop: "tool_use" },
      ],
      [{ type: "text", delta: "second turn" }, { type: "done", stop: "end" }],
    ];
    const session = await Session.create({ cwd: CWD, model: "m", home: HOME });
    const { provider } = fakeProvider(script);
    agent = new Agent({ provider, model: "t", system: "sys", tools: [tool], maxTurns: 5, maxCost: 10, session });

    const result = await agent.prompt("do it");
    expect(result.reason).toBe("aborted");
    expect(agent.messages.some((m) => m.content === "Aborted by user")).toBe(true);

    const reloaded = await Session.load(session.path);
    const history = reloaded.view();
    const calls = history.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    const results = history.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(calls.length).toBeGreaterThan(0);
    expect(results.toSorted()).toEqual(calls.toSorted()); // one result per call, no orphans
    for (const id of calls) expect(results.filter((r) => r === id)).toHaveLength(1);

    // Resuming reuses the same agent state and continues on the same log.
    const next = agentWith(reloaded, { stream: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text", delta: "resumed" };
      yield { type: "done", stop: "end" };
    } });
    expect(next.messages.map((m) => m.content)).toEqual(history.map((m) => m.content));
    await next.prompt("again");
    expect(reloaded.view().at(-1)!.content).toBe("resumed");
  });

  test("4. replaying the same history twice produces byte-identical request bodies", async () => {
    rmSync(HOME, { recursive: true, force: true });
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        bodies.push(await request.text());
        const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`;
        return new Response(new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode(`${frame}data: [DONE]\n\n`));
            ctl.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const session = await Session.create({ cwd: CWD, model: "m", home: HOME });
    const history: Message[] = [
      { id: "m1", role: "user", content: "read a.txt" },
      { id: "m2", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
      { id: "m3", role: "tool", content: "1: a", toolCallId: "c1" },
      { id: "m4", role: "assistant", content: "it says a", usage: { input: 1, output: 2 } as Usage },
    ];
    // oxlint-disable-next-line no-await-in-loop -- appends must land in order
    for (const m of history) await session.append(m);

    const reloaded = await Session.load(session.path);
    const provider = openaiCompat({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "k" });
    const req = { model: "m", system: "sys", tools: [], signal: new AbortController().signal };
    const replay = async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop -- one request per pass, deliberately sequential
      for await (const ev of provider.stream({ ...req, messages: reloaded.view() })) void ev;
    };
    await replay();
    await replay();
    server.stop(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]!);
    // Tool-call arguments must serialize the same way on both passes.
    expect(bodies[0]).toContain('"arguments":"{\\"path\\":\\"a.txt\\"}"');
  });

  test("5. --continue picks the newest session of this project", async () => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(CWD, { recursive: true });
    const first = await Session.create({ cwd: CWD, model: "m", home: HOME });
    await first.append({ id: "a", role: "user", content: "first" });
    // Linux stamps mtimes from a coarse clock (a few ms per tick): two writes microseconds apart
    // can share one, and then "newest" is a tie. The pause goes BETWEEN them (it used to follow both).
    await new Promise((r) => setTimeout(r, 25));
    const second = await Session.create({ cwd: CWD, model: "m", home: HOME });
    await second.append({ id: "b", role: "user", content: "second" });

    expect(latestSession(CWD, HOME)).toBe(second.path);
    expect((await Session.load(latestSession(CWD, HOME)!)).view().at(-1)!.content).toBe("second");
    expect(latestSession(`${HOME}/other`, HOME)).toBeUndefined();
    expect(sessionDir(CWD, HOME)).toStartWith(`${HOME}/.kinoko/sessions/`);
  });

  test("6. compaction record turns the log into summary + verbatim tail", async () => {
    const session = await Session.create({ cwd: CWD, model: "m", home: HOME });
    for (const id of ["m1", "m2", "m3", "m4"]) {
      // oxlint-disable-next-line no-await-in-loop -- appends must land in order
      await session.append({ id, role: "user", content: `body ${id}` });
    }
    const summary = await session.markCompaction({ id: "s1", role: "user", content: "<compacted_summary>" }, "m3");

    const reloaded = await Session.load(session.path);
    expect(reloaded.view().map((m) => m.content)).toEqual(["<compacted_summary>", "body m3", "body m4"]);
    // The full log is still there: a fork can go back before the compaction.
    expect(reloaded.activeBranch()).toHaveLength(5);
    expect(summary.content).toStartWith("<compacted_summary>");
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!).type).toBe("compaction");
  });

  test("7. --session finds an id, or a prefix only one session has, in this directory only", async () => {
    const cwd = `${HOME}/resume-here`;
    const a = await Session.create({ cwd, model: "m", home: HOME });
    const b = await Session.create({ cwd, model: "m", home: HOME });
    expect(findSession(cwd, a.meta.id, HOME)).toBe(a.path);
    expect(findSession(cwd, ` ${b.meta.id}.jsonl `, HOME)).toBe(b.path); // pasted with its extension
    // A prefix works when it is unique; the empty prefix matches both, so it finds nothing.
    let unique = 1;
    while (a.meta.id.slice(0, unique) === b.meta.id.slice(0, unique)) unique++;
    expect(findSession(cwd, a.meta.id.slice(0, unique), HOME)).toBe(a.path);
    expect(findSession(cwd, "", HOME)).toBeUndefined();
    // Sessions are kept per directory: the same id from elsewhere is not found.
    expect(findSession(`${HOME}/somewhere-else`, a.meta.id, HOME)).toBeUndefined();
    expect(findSession(cwd, "no-such-session", HOME)).toBeUndefined();
  });

  test("8. a session is empty until something is said in it", async () => {
    const session = await Session.create({ cwd: `${HOME}/empty`, model: "m", home: HOME });
    expect(session.empty).toBe(true);
    await session.append({ id: "u", role: "user", content: "hi" });
    expect(session.empty).toBe(false);
    expect((await Session.load(session.path)).empty).toBe(false);
  });
});
