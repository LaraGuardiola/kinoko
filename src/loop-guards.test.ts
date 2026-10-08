import { describe, expect, test } from "bun:test";
import { MAX_NUDGES, NUDGE_EMPTY, NUDGE_LENGTH, NUDGE_REPEAT, REPEAT_LINES, STOP_CALLS, WARN_CALLS } from "./guard.ts";
import { Agent, type AgentEvent } from "./loop.ts";
import type { Provider, StreamEvent } from "./types.ts";

function scripted(turns: StreamEvent[][]): Provider & { requests: number } {
  const p = {
    requests: 0,
    stream: async function* (): AsyncIterable<StreamEvent> {
      const turn = turns[Math.min(p.requests++, turns.length - 1)]!;
      for (const ev of turn) yield ev;
    },
  };
  return p;
}

const cut: StreamEvent[] = [{ type: "thinking", delta: "planning the whole file..." }, { type: "done", stop: "length" }];
const answer: StreamEvent[] = [{ type: "text", delta: "done" }, { type: "done", stop: "end" }];

function agentWith(provider: Provider, tools = [] as ConstructorParameters<typeof Agent>[0]["tools"]): Agent {
  return new Agent({ provider, model: "t", system: "", tools, maxTurns: 100, maxCost: 100 });
}

describe("loop guards", () => {
  test("a reply cut by the output limit is nudged to continue instead of ending the run", async () => {
    const agent = agentWith(scripted([cut, answer]));
    expect((await agent.prompt("build it")).reason).toBe("done");
    const users = agent.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["build it", NUDGE_LENGTH]);
    // The cut reply keeps its thinking, so the model can pick up where it stopped.
    expect(agent.messages[1]!.thinking).toBe("planning the whole file...");
  });

  test("after MAX_NUDGES cut replies in a row the run stops and says why", async () => {
    const agent = agentWith(scripted([cut]));
    let detail: string | undefined;
    agent.on((e: AgentEvent) => {
      if (e.type === "run_end") detail = e.detail;
    });
    expect((await agent.prompt("build it")).reason).toBe("limit");
    expect(agent.messages.filter((m) => m.content === NUDGE_LENGTH)).toHaveLength(MAX_NUDGES);
    expect(detail).toContain("maxOutputTokens");
  });

  test("looping thinking is cut mid-stream, dropped from history, and nudged", async () => {
    const loop: StreamEvent[] = [];
    for (let i = 0; i < REPEAT_LINES * 4; i++) loop.push({ type: "thinking", delta: "Writing chunk manager code for the mesher...\n" });
    loop.push({ type: "tool_call", call: { id: "x", name: "never", args: {} } }, { type: "done", stop: "tool_use" });
    const provider = scripted([loop, answer]);
    const agent = agentWith(provider);
    expect((await agent.prompt("go")).reason).toBe("done");
    const cutReply = agent.messages[1]!;
    expect(cutReply.thinking).toBeUndefined();
    expect(cutReply.toolCalls).toBeUndefined();
    expect(agent.messages[2]!.content).toBe(NUDGE_REPEAT);
  });

  test("an empty reply (a tool call written inside the thinking) is nudged, not taken as done", async () => {
    const lost: StreamEvent[] = [{ type: "thinking", delta: "<tool_call>\n<function=write>" }, { type: "done", stop: "end" }];
    const agent = agentWith(scripted([lost, answer]));
    expect((await agent.prompt("go")).reason).toBe("done");
    expect(agent.messages[2]!.content).toBe(NUDGE_EMPTY);
    expect(agent.messages.at(-1)!.content).toBe("done");
  });

  test("a write repeated with identical content is told its effect is already in place", async () => {
    const tool = { name: "write", description: "", schema: {}, run: async () => "wrote 3 lines (40 chars) to a.ts" };
    const call: StreamEvent[] = [
      { type: "tool_call", call: { id: "w", name: "write", args: { path: "a.ts", content: "same" } } },
      { type: "done", stop: "tool_use" },
    ];
    const agent = agentWith(scripted([call, call, call, answer]), [tool]);
    await agent.prompt("fix it");
    const third = agent.messages.filter((m) => m.role === "tool")[WARN_CALLS - 1]!.content;
    expect(third).toContain("the file holds exactly this content");
    expect(third).not.toContain("got this exact result");
  });

  test("the same call with the same result is flagged, then stops the run", async () => {
    const tool = { name: "check", description: "", schema: {}, readOnly: true, run: async () => "1 error" };
    const call: StreamEvent[] = [
      { type: "tool_call", call: { id: "c", name: "check", args: { all: true } } },
      { type: "done", stop: "tool_use" },
    ];
    const agent = agentWith(scripted([call]), [tool]);
    const result = await agent.prompt("fix it");
    expect(result.reason).toBe("limit");
    expect(result.detail).toContain(`${STOP_CALLS} times`);
    const results = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toHaveLength(STOP_CALLS);
    expect(results[WARN_CALLS - 2]).toBe("1 error");
    expect(results[WARN_CALLS - 1]).toContain(`this exact call ${WARN_CALLS} times`);
  });
});
