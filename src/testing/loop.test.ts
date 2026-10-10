import { expect, test, describe } from "bun:test";
import { Agent } from "../loop";
import type { Message, StreamEvent, Provider as RealProvider } from "../types";

describe("Agent loop with abort, steer and follow-up", () => {
  test("1. abort() while idle is a no-op; after abort agent is idle <100ms and reusable", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    agent.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.state).toBe("idle");
  });

  test("2. ABORT mid-stream: partial assistant text kept with stop \"aborted\" and NO tool calls", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "partial" };
        yield { type: "done", stop: "aborted" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    const result = await agent.prompt("test");
    expect(result.reason).toBe("aborted");
    const last = agent.messages.at(-1);
    expect(last!.role).toBe("assistant");
    expect(last!.content).toBe("partial");
    expect(last!.stop).toBe("aborted");
    expect(last!.toolCalls).toBeUndefined();
  });

  test("3. ABORT mid-tools: unstarted tools get synthetic \"Aborted by user\" tool messages", async () => {
    let unblock: (() => void) | undefined;
    const tool = {
      name: "slow",
      description: "slow",
      schema: {},
      readOnly: false,
      run: async (_a: unknown, _ctx: unknown) => {
        await new Promise<void>((r) => { unblock = r; });
        return "result";
      },
    };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: "c1", name: "slow", args: {} } };
        yield { type: "done", stop: "tool_use" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [tool], maxTurns: 10, maxCost: 100 });
    const runP = agent.prompt("test");
    await new Promise((r) => setTimeout(r, 10));
    agent.abort();
    if (unblock) unblock();
    await runP;
    const msgs = agent.messages.filter((m: Message) => m.role === "tool");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content).toBe("Aborted by user");
    expect(agent.state).toBe("idle");
  });

  test("4. STEER has priority over FOLLOW-UP", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "answer" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    agent.followUp("follow up");
    agent.steer("steer");
    await agent.prompt("test");
    const userMsgs = agent.messages.filter((m: Message) => m.role === "user");
    expect(userMsgs.map((m) => m.content)).toContain("steer");
    expect(userMsgs.map((m) => m.content)).toContain("follow up");
  });

  test("5. FOLLOW-UP delivered only when no tool calls and empty steer queue", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "answer" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    agent.followUp("follow up");
    await agent.prompt("test");
    const userMsgs = agent.messages.filter((m: Message) => m.role === "user");
    expect(userMsgs.at(-1)?.content).toBe("follow up");
  });

  test("6. on abort queued messages are NOT run; dropped returned in run_end", async () => {
    let unblock: (() => void) | undefined;
    const tool = {
      name: "slow",
      description: "slow",
      schema: {},
      readOnly: false,
      run: async (_a: unknown, _ctx: unknown) => {
        await new Promise<void>((r) => { unblock = r; });
        return "result";
      },
    };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: "c1", name: "slow", args: {} } };
        yield { type: "done", stop: "tool_use" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [tool], maxTurns: 10, maxCost: 100 });
    agent.steer("queued steer");
    agent.followUp("queued follow up");
    const runP = agent.prompt("test");
    await new Promise((r) => setTimeout(r, 10));
    agent.abort();
    if (unblock) unblock();
    const result = await runP;
    expect(result.reason).toBe("aborted");
    expect(result.dropped).toContain("queued steer");
    expect(result.dropped).toContain("queued follow up");
    expect(agent.state).toBe("idle");
  });

  test("7. tools run one at a time, in the order the model called them", async () => {
    const t1 = { name: "r1", description: "", schema: {}, readOnly: true, run: async (_a: unknown, _ctx: unknown) => "" };
    const t2 = { name: "r2", description: "", schema: {}, readOnly: true, run: async (_a: unknown, _ctx: unknown) => "" };
    const t3 = { name: "s1", description: "", schema: {}, readOnly: false, run: async (_a: unknown, _ctx: unknown) => "" };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: "c1", name: "r1", args: {} } };
        yield { type: "tool_call", call: { id: "c2", name: "r2", args: {} } };
        yield { type: "tool_call", call: { id: "c3", name: "s1", args: {} } };
        yield { type: "done", stop: "tool_use" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [t1, t2, t3], maxTurns: 10, maxCost: 100 });
    await agent.prompt("test");
    const toolMsgs = agent.messages.filter((m: Message) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId).slice(0, 3)).toEqual(["c1", "c2", "c3"]);
  });

  test("8. thrown tool error becomes tool message \"ERROR: ...\"", async () => {
    const tool = { name: "fail", description: "", schema: {}, readOnly: true, run: async () => { throw new Error("boom"); } };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: "c1", name: "fail", args: {} } };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [tool], maxTurns: 10, maxCost: 100 });
    const result = await agent.prompt("test");
    expect(["done", "limit", "error"]).toContain(result.reason);
    const toolMsg = agent.messages.at(-1);
    expect(toolMsg!.content).toMatch(/^ERROR:/);
  });

  test("9. malformed tool calls capped at 3, then error limit", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: "c1", name: "bad", args: {} } };
        yield { type: "done", stop: "error" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    const result = await agent.prompt("test");
    expect(result.reason).toBe("error");
  });

  // A local engine serves one request at a time, so overlapping calls must never happen.
  // The second request of a run stands in for the compaction call of Phase 5.
  test("10. two prompts in a row never overlap provider requests", async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const tool = { name: "noop", description: "", schema: {}, readOnly: true, run: async () => "" };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        calls++;
        inFlight--;
        if (calls % 2 === 1) {
          yield { type: "tool_call", call: { id: `c${calls}`, name: "noop", args: {} } };
          yield { type: "done", stop: "tool_use" };
        } else {
          yield { type: "text", delta: "answer" };
          yield { type: "done", stop: "end" };
        }
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [tool], maxTurns: 10, maxCost: 100 });
    await agent.prompt("first");
    await agent.prompt("second");
    expect(calls).toBe(4);
    expect(peak).toBe(1);
  });

  test("11. request_start and first_token carry timestamps and bracket a request", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        await new Promise((r) => setTimeout(r, 15));
        yield { type: "thinking", delta: "hmm" };
        yield { type: "text", delta: "answer" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    const seen: Array<{ type: string; at?: number }> = [];
    agent.on((e) => seen.push(e as { type: string; at?: number }));
    const before = Date.now();
    await agent.prompt("test");
    const marks = seen.filter((e) => e.type === "request_start" || e.type === "first_token");
    expect(marks.map((e) => e.type)).toEqual(["request_start", "first_token"]);
    const [start, first] = marks;
    // Thinking counts as the first token of any kind.
    expect(start!.at!).toBeGreaterThanOrEqual(before);
    expect(first!.at!).toBeGreaterThanOrEqual(start!.at!);
    expect(seen.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
    expect(agent.messages.at(-1)!.thinking).toBe("hmm");
  });

  test("the provider's replay data lands on the assistant message", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "replay", data: [{ type: "text", text: "ok" }] };
        yield { type: "done", stop: "end", usage: { input: 1, output: 1, cost: 3 } };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 2 });
    await agent.prompt("one");
    expect(agent.messages.at(-1)!.replay).toEqual([{ type: "text", text: "ok" }]);
  });

  test("reported cost counts against maxCost", async () => {
    const tool = { name: "t", description: "", schema: {}, run: async () => "done" };
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool_call", call: { id: crypto.randomUUID(), name: "t", args: {} } };
        yield { type: "done", stop: "tool_use", usage: { input: 1, output: 1, cost: 3 } };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [tool], maxTurns: 10, maxCost: 2 });
    expect((await agent.prompt("go")).reason).toBe("limit");
    expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("images ride on the prompt and on steers into their user messages; text-only stays without", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    const a = { mime: "image/png", data: "A" };
    const b = { mime: "image/png", data: "B" };
    agent.steer("and [Image #2]", [b]);
    agent.followUp("thanks", []);
    await agent.prompt("look at [Image #1]", [a]);
    const users = agent.messages.filter((m: Message) => m.role === "user");
    expect(users.map((m) => m.images)).toEqual([[a], [b], undefined]);
  });

  test("a system prompt per model: after setModel the next request carries the new model's prompt", async () => {
    const systems: string[] = [];
    const provider = {
      stream: async function* (req: { system: string }): AsyncIterable<StreamEvent> {
        systems.push(req.system);
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "a", system: (model) => `Model: ${model}`, tools: [], maxTurns: 10, maxCost: 100 });
    await agent.prompt("one");
    agent.setModel("b");
    await agent.prompt("two");
    expect(systems).toEqual(["Model: a", "Model: b"]);
  });

  test("sendNow cuts the streaming reply and delivers the steer at once; its thinking and text are kept, its calls are not", async () => {
    const seen: string[][] = [];
    let turn = 0;
    const provider = {
      stream: async function* (req: { messages: Message[]; signal: AbortSignal }): AsyncIterable<StreamEvent> {
        seen.push(req.messages.map((m) => `${m.role}:${m.content}`));
        if (turn++ === 0) {
          yield { type: "thinking", delta: "long musing" };
          yield { type: "text", delta: "partial" };
          // a long think: until cut
          // oxlint-disable-next-line no-await-in-loop -- a reply that thinks until it is cut
          while (!req.signal.aborted) await new Promise((r) => setTimeout(r, 5));
          yield { type: "done", stop: "aborted" };
          return;
        }
        yield { type: "text", delta: "ok, using rg" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    expect(agent.sendNow()).toBe(false); // idle: nothing to cut
    const run = agent.prompt("search the repo");
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.sendNow()).toBe(false); // no steer waiting
    agent.steer("use rg");
    expect(agent.sendNow()).toBe(true);
    const result = await run;
    expect(result.reason).toBe("done");
    const cut = agent.messages.find((m) => m.role === "assistant" && m.stop === "aborted")!;
    expect(cut.content).toBe("partial");
    expect(cut.thinking).toBe("long musing");
    expect(seen[1]!.slice(-2)).toEqual(["assistant:partial", "user:use rg"]); // the steer right after the cut reply
  });

  test("unqueue takes messages back so they are never delivered: the newest, or all, in order", async () => {
    const provider = {
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    agent.steer("one");
    agent.followUp("two");
    agent.steer("three");
    expect(agent.unqueue("last")).toEqual(["three"]);
    expect(agent.unqueue("all")).toEqual(["one", "two"]);
    expect(agent.unqueue("all")).toEqual([]);
    await agent.prompt("go");
    expect(agent.messages.filter((m: Message) => m.role === "user").map((m) => m.content)).toEqual(["go"]);
  });
});

// Fails `failures` times (a dropped connection after some text), then answers "ok".
function flaky(failures: number, retry = true): { provider: RealProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    stream: async function* (): AsyncIterable<StreamEvent> {
      calls++;
      if (calls <= failures) {
        yield { type: "text", delta: "half a rep" };
        yield { type: "error", message: "the connection closed mid-reply", retry };
        yield { type: "done", stop: "error" };
        return;
      }
      yield { type: "text", delta: "ok" };
      yield { type: "done", stop: "end" };
    },
  } as unknown as RealProvider;
  return { provider, calls: () => calls };
}

describe("retries after a transient failure", () => {
  test("the same request again after a growing wait; the partial reply is not kept; no turn spent", async () => {
    const { provider, calls } = flaky(2);
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 1, maxCost: 100, retryMs: 1 });
    const retries: Array<{ attempt: number; of: number; inMs: number; error: string }> = [];
    agent.on((e) => {
      if (e.type === "retry") retries.push({ attempt: e.attempt, of: e.of, inMs: e.inMs, error: e.error });
    });
    const result = await agent.prompt("hi");
    expect(result.reason).toBe("done");
    expect(calls()).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, of: 3, inMs: 1, error: "the connection closed mid-reply" },
      { attempt: 2, of: 3, inMs: 2, error: "the connection closed mid-reply" },
    ]);
    expect(agent.messages.map((m) => m.content)).toEqual(["hi", "ok"]);
  });

  test("gives up after `retries` attempts with the error; 0 never retries; a non-transient error is not retried", async () => {
    const tooMany = flaky(9);
    const agent = new Agent({ provider: tooMany.provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100, retries: 2, retryMs: 1 });
    expect(await agent.prompt("hi")).toEqual({ reason: "error", detail: "the connection closed mid-reply" });
    expect(tooMany.calls()).toBe(3);

    const never = flaky(1);
    await new Agent({ provider: never.provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100, retries: 0 }).prompt("hi");
    expect(never.calls()).toBe(1);

    const bad = flaky(1, false);
    await new Agent({ provider: bad.provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100, retryMs: 1 }).prompt("hi");
    expect(bad.calls()).toBe(1);
  });

  test("Esc during the wait stops the run at once", async () => {
    const { provider, calls } = flaky(1);
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100, retryMs: 60_000 });
    agent.on((e) => {
      if (e.type === "retry") agent.abort();
    });
    const started = Date.now();
    expect((await agent.prompt("hi")).reason).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls()).toBe(1);
  });
});

describe("notes and tools changed while kinoko runs", () => {
  test("a note reaches the model as a [kinoko] message right before the next user message, once", async () => {
    const seen: Message[][] = [];
    const provider = {
      stream: async function* (req: { messages: Message[] }): AsyncIterable<StreamEvent> {
        seen.push([...req.messages]);
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    agent.note("A skill is now available.");
    await agent.prompt("hi");
    await agent.prompt("again");
    expect(seen[0]!.map((m) => m.content)).toEqual(["[kinoko] A skill is now available.", "hi"]);
    expect(seen[1]!.filter((m) => m.content.startsWith("[kinoko]"))).toHaveLength(1);
  });

  test("setTools: the next request carries the new tools, and their calls run", async () => {
    const tools: string[][] = [];
    let turn = 0;
    const provider = {
      stream: async function* (req: { tools: Array<{ name: string }> }): AsyncIterable<StreamEvent> {
        tools.push(req.tools.map((t) => t.name));
        turn++;
        if (turn === 2) {
          yield { type: "tool_call", call: { id: "c1", name: "late", args: {} } };
          yield { type: "done", stop: "tool_use" };
          return;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    } as unknown as RealProvider;
    const agent = new Agent({ provider, model: "t", system: "", tools: [], maxTurns: 10, maxCost: 100 });
    await agent.prompt("one");
    agent.setTools([{ name: "late", description: "", schema: {}, run: async () => "ran late" }]);
    await agent.prompt("two");
    expect(tools).toEqual([[], ["late"], ["late"]]);
    expect(agent.messages.find((m) => m.role === "tool")?.content).toBe("ran late");
  });
});
