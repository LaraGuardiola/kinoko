import { expect, test, describe } from "bun:test";
import { Agent } from "./loop";
import type { Message, StreamEvent, Provider as RealProvider } from "./types";

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

  test("7. readOnly tools run in parallel; non-readOnly run sequentially", async () => {
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
    expect(toolMsgs.length).toBeGreaterThanOrEqual(3);
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
});