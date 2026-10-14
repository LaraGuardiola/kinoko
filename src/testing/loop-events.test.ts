// The events Kinoko Lab draws from: what the loop does between the lines a chat shows.

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../agent-events.ts";
import { Extensions } from "../ext.ts";
import { NUDGE_EMPTY, WARN_CALLS } from "../guard.ts";
import { Agent } from "../loop.ts";
import type { Provider, StreamEvent, Tool } from "../types.ts";

/** A model that plays its replies in order (the last one again when they run out). */
function scripted(turns: StreamEvent[][]): Provider {
  let n = 0;
  return {
    stream: async function* (): AsyncIterable<StreamEvent> {
      for (const ev of turns[Math.min(n++, turns.length - 1)]!) yield ev;
    },
  };
}

const answer: StreamEvent[] = [{ type: "text", delta: "done" }, { type: "done", stop: "end" }];
const call = (name: string, args: Record<string, unknown> = {}, id = "c1"): StreamEvent[] => [{ type: "tool_call", call: { id, name, args } }, { type: "done", stop: "tool_use" }];

const echo: Tool = { name: "echo", description: "says it back", schema: { type: "object" }, run: async (args: { text?: string }) => args.text ?? "same" };

function agentWith(provider: Provider, opts: { tools?: Tool[]; extensions?: Extensions; system?: string } = {}): { agent: Agent; events: AgentEvent[] } {
  const agent = new Agent({ provider, model: "m", system: opts.system ?? "be brief", tools: opts.tools ?? [echo], maxTurns: 50, maxCost: 100, extensions: opts.extensions });
  const events: AgentEvent[] = [];
  agent.on((e) => events.push(e));
  return { agent, events };
}

function ofType<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

describe("the events Kinoko Lab draws", () => {
  test("request_start says the request's size: model, messages, tools, characters, tokens", async () => {
    const { agent, events } = agentWith(scripted([answer]));
    await agent.prompt("hello there");
    const [request] = ofType(events, "request_start");
    expect(request).toMatchObject({ model: "m", messages: 1, tools: 1 });
    // The system prompt, the tool's schema and the prompt are all read by the model.
    expect(request!.chars).toBeGreaterThan("be brief".length + "hello there".length);
    expect(request!.tokens).toBeGreaterThan(0);
  });

  test("prefill progress is passed on a few times a second, the last one always", async () => {
    const reading: StreamEvent[] = [];
    for (let done = 0; done <= 1000; done += 10) reading.push({ type: "progress", done, total: 1000 });
    const { agent, events } = agentWith(scripted([[...reading, ...answer]]));
    await agent.prompt("go");
    const prefill = ofType(events, "prefill");
    expect(prefill.length).toBeLessThan(10);
    expect(prefill.at(-1)).toEqual({ type: "prefill", done: 1000, total: 1000 });
    // It is not the model's first token: that is still the first thing it writes.
    expect(events.findIndex((e) => e.type === "first_token")).toBeGreaterThan(events.lastIndexOf(prefill.at(-1)!));
  });

  test("the gate's word on each call: pass, block or ask, with who decided and whether args changed", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("careful", (k) =>
      k.on("tool_call", (c) => {
        if (c.args.text === "forbidden") return { block: true, reason: "not that" };
        if (c.args.text === "shout") c.args.text = "SHOUT";
        if (c.args.text === "risky") return { ask: true, reason: "sure?" };
        return undefined;
      }),
    );
    const turns = [call("echo", { text: "fine" }, "a"), call("echo", { text: "forbidden" }, "b"), call("echo", { text: "shout" }, "c"), call("echo", { text: "risky" }, "d"), answer];
    const { agent, events } = agentWith(scripted(turns), { extensions: ext });
    agent.setAutoApprove(true); // nobody is asked: the gate says it skipped the question
    await agent.prompt("go");
    // toEqual takes a field left undefined as one not there.
    const gates: object[] = ofType(events, "gate").map((g) => ({ id: g.call.id, decision: g.decision, reason: g.reason, by: g.by, rewritten: g.rewritten, skipped: g.skipped }));
    expect(gates).toEqual([
      { id: "a", decision: "pass" },
      { id: "b", decision: "block", reason: "not that", by: "careful" },
      { id: "c", decision: "pass", rewritten: true },
      { id: "d", decision: "ask", reason: "sure?", by: "careful", skipped: "auto" },
    ]);
    // The gate comes between the call's start and its result.
    const order = events.filter((e) => (e.type === "tool_start" || e.type === "gate" || e.type === "tool_output") && e.call.id === "b").map((e) => e.type);
    expect(order).toEqual(["tool_start", "gate", "tool_output"]);
  });

  test("without extensions every call passes the gate", async () => {
    const { agent, events } = agentWith(scripted([call("echo"), answer]));
    await agent.prompt("go");
    expect(ofType(events, "gate").map((g) => g.decision)).toEqual(["pass"]);
  });

  test("appended tells each message joining the history and why; the harness's own words in full", async () => {
    const { agent, events } = agentWith(scripted([call("echo", { text: "hi" }), answer, answer]));
    agent.note("a skill was installed");
    agent.followUp("and then this");
    await agent.prompt("go");
    const appended = ofType(events, "appended").map(({ type: _type, ...rest }) => rest);
    expect(appended).toEqual([
      { role: "user", kind: "note", chars: "[kinoko] a skill was installed".length, text: "[kinoko] a skill was installed" },
      { role: "user", kind: "prompt", chars: 2 },
      { role: "assistant", kind: "reply", chars: 0 },
      { role: "tool", kind: "result", chars: 2 },
      { role: "assistant", kind: "reply", chars: 4 },
      { role: "user", kind: "follow_up", chars: "and then this".length },
      { role: "assistant", kind: "reply", chars: 4 },
    ]);
    // run_start opens the run: everything it appends comes after.
    expect(events.findIndex((e) => e.type === "run_start")).toBeLessThan(events.findIndex((e) => e.type === "appended"));
  });

  test("a steer is appended as a steer", async () => {
    const { agent, events } = agentWith(scripted([call("echo"), answer]));
    agent.on((e) => {
      if (e.type === "tool_start") agent.steer("look here");
    });
    await agent.prompt("go");
    expect(ofType(events, "appended").map((a) => a.kind)).toEqual(["prompt", "reply", "result", "steer", "reply"]);
  });

  test("a guard says what it noticed, then the nudge it sent is appended in full", async () => {
    const empty: StreamEvent[] = [{ type: "done", stop: "end" }];
    const { agent, events } = agentWith(scripted([empty, answer]));
    await agent.prompt("go");
    const at = events.findIndex((e) => e.type === "guard");
    expect(events[at]).toEqual({ type: "guard", what: "empty", detail: "the model keeps replying with nothing" });
    expect(events[at + 1]).toEqual({ type: "appended", role: "user", kind: "nudge", chars: NUDGE_EMPTY.length, text: NUDGE_EMPTY });
  });

  test("guards on calls: an unknown tool, the same call returning the same result", async () => {
    const turns: StreamEvent[][] = [call("nope")];
    for (let i = 0; i < WARN_CALLS; i++) turns.push(call("echo", {}, `e${i}`));
    turns.push(answer);
    const { agent, events } = agentWith(scripted(turns));
    await agent.prompt("go");
    expect(ofType(events, "guard").map((g) => g.what)).toEqual(["unknown_tool", "same_call"]);
    expect(ofType(events, "guard")[0]!.detail).toContain("nope");
  });
});

describe("inspect: what the model sees, for a person", () => {
  test("nothing sent yet: no request; the system prompt and the tools are there from the start", () => {
    const { agent } = agentWith(scripted([answer]));
    expect(agent.inspect("request")).toBeUndefined();
    expect(agent.inspect("system")).toBe("be brief");
    expect(agent.inspect("tools")).toEqual([{ name: "echo", description: "says it back", schema: { type: "object" } }]);
  });

  test("the last request as sent: plain JSON, no signal, no tool code, no image bytes", async () => {
    const { agent } = agentWith(scripted([answer]));
    agent.setThinking("high", 2000);
    await agent.prompt("look", [{ mime: "image/png", data: "AAAA" }]);
    const request = agent.inspect("request") as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(["model", "effort", "budget", "system", "tools", "messages"]);
    expect(request).toMatchObject({ model: "m", effort: "high", budget: 2000, system: "be brief" });
    expect(request.messages).toEqual([expect.objectContaining({ role: "user", content: "look", images: [{ mime: "image/png", data: "", size: 3 }] })]);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });

  test("extensions hear every event too (agent_event), in the order the clients do", async () => {
    const ext = new Extensions(() => undefined);
    const heard: string[] = [];
    await ext.start("voice", (k) => k.on("agent_event", (e) => void heard.push(e.type === "message_delta" ? `delta:${e.delta}` : e.type)));
    const { agent, events } = agentWith(scripted([[{ type: "text", delta: "ho" }, { type: "text", delta: "la" }, { type: "done", stop: "end" }]]), { extensions: ext });
    await agent.prompt("hi");
    expect(heard).toEqual(events.map((e) => (e.type === "message_delta" ? `delta:${e.delta}` : e.type)));
    expect(heard).toContain("delta:ho");
    expect(heard.at(-1)).toBe("run_end");
  });
});
