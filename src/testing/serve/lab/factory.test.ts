// Kinoko Lab's factory fed by a real Agent's events (a scripted model, fake tools): what the floor
// shows must follow what the loop really says, in the order it says it.

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../../agent-events.ts";
import { Extensions } from "../../../ext.ts";
import { Agent } from "../../../loop.ts";
import { Factory } from "../../../serve/lab/factory.ts";
import type { Move } from "../../../serve/lab/factory.ts";
import { FLOOR } from "../../../serve/lab/machines.ts";
import { tileOf } from "../../../serve/lab/tiles.ts";
import type { Provider, StreamEvent, Tool } from "../../../types.ts";

function scripted(turns: StreamEvent[][]): Provider {
  let n = 0;
  return {
    stream: async function* (): AsyncIterable<StreamEvent> {
      for (const ev of turns[Math.min(n++, turns.length - 1)]!) yield ev;
    },
  };
}

const say = (text: string): StreamEvent[] => [{ type: "thinking", delta: "hm" }, { type: "text", delta: text }, { type: "done", stop: "end", usage: { input: 100, output: 5, cacheRead: 60 } }];
const call = (name: string, args: Record<string, unknown>, id = "c1"): StreamEvent[] => [
  { type: "progress", done: 100, total: 100 },
  { type: "tool_pending", name, index: 0 },
  { type: "tool_call", call: { id, name, args } },
  { type: "done", stop: "tool_use", usage: { input: 90, output: 10 } },
];

const echo: Tool = { name: "echo", description: "says it back", schema: {}, run: async (args: { text: string }) => args.text };

/** A Factory watching an agent: every event applied, every move kept. */
function watch(turns: StreamEvent[][], extensions?: Extensions): { agent: Agent; factory: Factory; moves: Move[]; events: AgentEvent[] } {
  const agent = new Agent({ provider: scripted(turns), model: "m", system: "sys", tools: [echo], maxTurns: 20, maxCost: 100, extensions });
  const factory = new Factory();
  const moves: Move[] = [];
  const events: AgentEvent[] = [];
  agent.on((e) => {
    events.push(e);
    moves.push(...factory.apply(e));
  });
  return { agent, factory, moves, events };
}

const routes = (moves: Move[]): string[] => moves.map((m) => `${m.route.join(">")}:${m.kind}`);

describe("Kinoko Lab: the factory", () => {
  test("a run with a tool call: the history it rebuilds is the agent's, the items ride the loop, the run leaves by the exit", async () => {
    const { agent, factory, moves } = watch([call("echo", { text: "hi" }), say("done")]);
    await agent.prompt("go");
    expect(factory.history.map((e) => [e.role, e.kind, e.content])).toEqual(agent.messages.map((m, i) => [m.role, ["prompt", "reply", "result", "reply"][i], m.content]));
    expect(factory.history[1]?.toolCalls?.[0]?.name).toBe("echo");
    expect(routes(moves)).toEqual([
      "inbox>history:user",
      "history>context>request:history",
      "press>request:system",
      "toolbox>request:tools",
      "request>prefill:request",
      "prefill>stream:token",
      "stream>history:reply",
      "stream>guards>dispatcher:reply",
      "dispatcher>gate:call",
      "gate>workbench:call",
      "workbench>history:result",
      "history>context>request:history",
      "press>request:system",
      "toolbox>request:tools",
      "request>prefill:request",
      "prefill>stream:token",
      "stream>history:reply",
      "dispatcher>exit:end",
    ]);
    expect(factory.running).toBe(false);
    expect(factory.caption).toContain("Done");
    expect(factory.turn).toBe(2);
    expect(factory.totals).toEqual({ requests: 2, input: 190, output: 15, cached: 60 });
    expect(tileOf(factory, "exit")).toEqual({ tone: "done", now: "done" });
    expect(tileOf(factory, "workbench").now).toBe("echo · 2 chars");
    expect(tileOf(factory, "prefill").now).toBe("100 · 60% cached");
    expect(tileOf(factory, "stream").now).toBe("replied · 4 chars");
  });

  test("while a call waits for the user the approval desk waits; allowed, the call rides on to the workbench", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("careful", (k) => k.on("tool_call", () => ({ ask: true, reason: "sure?" })));
    const { agent, factory, moves, events } = watch([call("echo", { text: "x" }), say("ok")], ext);
    const run = agent.prompt("go");
    // oxlint-disable-next-line no-await-in-loop -- waiting for the call to reach the desk is the point
    for (let i = 0; i < 100 && factory.approval === undefined; i++) await Bun.sleep(1);
    expect(tileOf(factory, "approval")).toEqual({ tone: "waiting", now: "waiting for you" });
    expect(factory.caption).toContain("careful asks you before echo runs");
    const ask = events.find((e) => e.type === "approval_request");
    agent.approve(ask?.type === "approval_request" ? ask.id : "", true, { by: "app" });
    await run;
    expect(routes(moves)).toContain("gate>approval:call");
    expect(routes(moves)).toContain("approval>workbench:call");
    expect(tileOf(factory, "approval").now).toBe("allowed · app");
  });

  test("a blocked call's answer rides back from the gate, a denied one from the approval desk", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("strict", (k) => k.on("tool_call", (c) => (c.args.text === "no" ? { block: true, reason: "never" } : { ask: true, reason: "sure?" })));
    const { agent, factory, moves, events } = watch([call("echo", { text: "no" }, "a"), call("echo", { text: "ask" }, "b"), say("ok")], ext);
    agent.on((e) => {
      if (e.type === "approval_request") queueMicrotask(() => agent.approve(e.id, false, { by: "tui" }));
    });
    await agent.prompt("go");
    expect(routes(moves).filter((r) => r.endsWith(":error"))).toEqual(["gate>history:error", "approval>gate>history:error"]);
    expect(factory.history.filter((e) => e.role === "tool").map((e) => e.content)).toEqual(["never", "ERROR: denied by the user: it did not run"]);
    expect(events.some((e) => e.type === "tool_output" && e.output === "never")).toBe(true);
  });

  test("an unknown tool: the guards notice, its error rides from them", async () => {
    const { agent, factory, moves } = watch([call("nope", {}), say("ok")]);
    await agent.prompt("go");
    expect(routes(moves)).toContain("guards>history:error");
    expect(factory.history.find((e) => e.role === "tool")?.content).toBe("ERROR: unknown tool");
    expect(factory.guards.map((g) => g.what)).toEqual(["unknown_tool"]);
  });

  test("a nudge: the guard's words join the history in full", async () => {
    const { agent, factory, moves } = watch([[{ type: "done", stop: "end" }], say("ok")]);
    await agent.prompt("go");
    expect(routes(moves)).toContain("guards>history:nudge");
    expect(factory.history[2]?.kind).toBe("nudge");
    expect(factory.history[2]?.content.length).toBeGreaterThan(20);
  });

  test("steers and follow-ups get their text when delivered", async () => {
    const { agent, factory } = watch([call("echo", { text: "a" }), say("one"), say("two")]);
    agent.on((e) => {
      if (e.type === "tool_start") agent.steer("look here");
    });
    agent.followUp("then this");
    await agent.prompt("go");
    expect(factory.history.filter((e) => e.kind === "steer" || e.kind === "follow_up").map((e) => [e.kind, e.content])).toEqual([
      ["steer", "look here"],
      ["follow_up", "then this"],
    ]);
  });

  test("compaction: the head becomes one summary, the kept tail stays", () => {
    const factory = new Factory();
    factory.load([1, 2, 3, 4, 5].map((i) => ({ id: `${i}`, role: i % 2 ? "user" : "assistant", content: `m${i}` })));
    expect(factory.apply({ type: "compacting", phase: "reading", done: 1, total: 4 })).toEqual([{ route: ["history", "compactor"], kind: "history" }]);
    expect(factory.apply({ type: "compacting", phase: "writing", done: 3, total: 4 })).toEqual([]);
    expect(tileOf(factory, "compactor")).toEqual({ tone: "busy", now: "summarising 3/4", progress: 0.75 });
    expect(factory.apply({ type: "compacted", keep: 2 })).toEqual([{ route: ["compactor", "history"], kind: "summary" }]);
    expect(factory.history.map((e) => e.kind ?? e.content)).toEqual(["summary", "m4", "m5"]);
  });

  test("the context filter's tile says when an extension changed what is sent", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("trim", (k) => k.on("context", (messages) => messages.slice(-1)));
    const { agent, factory } = watch([say("ok")], ext);
    factory.load([{ id: "x", role: "user", content: "old" }, { id: "y", role: "assistant", content: "older" }]);
    await agent.prompt("go");
    expect(tileOf(factory, "context").now).toBe("3 → 1 messages"); // the two loaded, and the prompt
  });

  test("every route the factory sends has a belt laid for each of its legs", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("mixed", (k) => k.on("tool_call", (c) => (c.args.text === "no" ? { block: true, reason: "no" } : c.args.text === "ask" ? { ask: true, reason: "?" } : undefined)));
    const { agent, moves } = watch([call("echo", { text: "a" }, "1"), call("echo", { text: "no" }, "2"), call("echo", { text: "ask" }, "3"), call("nope", {}), [{ type: "done", stop: "end" }], say("ok")], ext);
    agent.on((e) => {
      if (e.type === "approval_request") queueMicrotask(() => agent.approve(e.id, e.call.id === "3", { by: "app" }));
    });
    await agent.prompt("go");
    const legs = new Set(moves.flatMap((m) => m.route.slice(1).map((to, i) => `${m.route[i]}>${to}`)));
    const laid = new Set(FLOOR.belts.map((b) => `${b.from}>${b.to}`));
    expect([...legs].filter((leg) => !laid.has(leg))).toEqual([]);
  });
});
