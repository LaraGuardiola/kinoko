import { expect, test, describe } from "bun:test";
import { Rpc } from "../rpc.ts";
import { Agent } from "../loop.ts";
import type { RpcReply } from "../rpc.ts";
import type { StreamEvent, Tool } from "../types.ts";

interface Parsed {
  type: "event" | "ok" | "error";
  id?: string;
  text?: string;
  detail?: string;
  event?: { type: string };
  state?: { running: boolean; model: string; messages: number };
}

/** A scripted provider whose turns stay open long enough to interleave commands. */
function scripted(turns: StreamEvent[][], pace = 20): { stream: (req: { signal: AbortSignal }) => AsyncIterable<StreamEvent> } {
  let turn = 0;
  return {
    stream: async function* (req: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
      const events = turns[turn] ?? [{ type: "text", delta: "done" }, { type: "done", stop: "end" as const }];
      turn++;
      for (const ev of events) {
        if (req.signal.aborted) return;
        yield ev;
        // oxlint-disable-next-line no-await-in-loop -- the fake engine streams on purpose
        if (ev.type !== "done") await new Promise((r) => setTimeout(r, pace));
      }
    },
  };
}

interface Rig {
  rpc: Rpc;
  agent: Agent;
  lines: Parsed[];
  send: (command: unknown) => void;
  events: () => string[];
  replies: () => RpcReply[];
  settle: () => Promise<void>;
}

function rig(turns: StreamEvent[][], tools: Tool[] = [], pace = 20): Rig {
  const lines: Parsed[] = [];
  const { stream } = scripted(turns, pace);
  const agent = new Agent({ provider: { stream }, model: "rpc-model", system: "", tools, maxTurns: 8, maxCost: 10 });
  const rpc = new Rpc({ agent: agent, model: "rpc-model", write: (text) => lines.push(...parse(text)) });
  return {
    rpc: rpc,
    agent: agent,
    lines: lines,
    send: (command: unknown) => rpc.handle(JSON.stringify(command)),
    events: () => lines.filter((l) => l.type === "event").map((l) => l.event?.type ?? "?"),
    replies: () => lines.filter((l) => l.type !== "event") as RpcReply[],
    settle: async () => {
      // oxlint-disable-next-line no-await-in-loop -- polling is the point
      for (let i = 0; i < 60 && agent.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

function parse(text: string): Parsed[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Parsed);
}

const slow: Tool = {
  name: "slow",
  description: "",
  schema: {},
  readOnly: false,
  run: async (_args: unknown, ctx: { signal: AbortSignal }) => {
    await new Promise<void>((r) => setTimeout(r, 50));
    if (ctx.signal.aborted) throw new Error("Aborted by user");
    return "tool done";
  },
};

describe("rpc mode", () => {
  test("1. a prompt streams events out and finishes with an ok reply", async () => {
    const r = rig([[{ type: "text", delta: "hi" }, { type: "done", stop: "end" }]]);
    r.send({ type: "prompt", text: "hello", id: "1" });
    await r.settle();
    const events = r.events();
    expect(events.slice(0, 3)).toEqual(["run_start", "request_start", "first_token"]);
    expect(events).toContain("message_delta");
    expect(events).toContain("message_end");
    expect(events.at(-1)).toBe("run_end");
    const replies = r.replies();
    expect(replies[0]).toMatchObject({ type: "ok", id: "1", text: "started" });
    expect(replies.at(-1)).toMatchObject({ type: "ok", id: "1", text: "done" });
    expect(replies.at(-1)?.state?.running).toBe(false);
  });

  test("2. steer and follow_up land mid-run, abort cuts it: the event order holds", async () => {
    const r = rig(
      [
        [{ type: "tool_call", call: { id: "c1", name: "slow", args: {} } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "after" }, { type: "done", stop: "end" }],
      ],
      [slow],
      5,
    );
    r.send({ type: "prompt", text: "do it" });
    await new Promise((r2) => setTimeout(r2, 10));
    r.send({ type: "steer", text: "use rg instead" });
    r.send({ type: "follow_up", text: "and say why" });
    r.send({ type: "abort" });
    await r.settle();

    // Every reply came before the run ended, and the run ended as aborted.
    const order = r.lines.map((l) => (l.type === "event" ? `event:${l.event?.type}` : `${l.type}:${l.text ?? l.detail ?? ""}`));
    expect(order.indexOf("ok:steering")).toBeGreaterThan(-1);
    expect(order.indexOf("ok:follow up queued")).toBeGreaterThan(order.indexOf("ok:steering"));
    expect(order.indexOf("ok:aborting")).toBeGreaterThan(order.indexOf("ok:follow up queued"));
    expect(order.indexOf("ok:aborting")).toBeLessThan(order.lastIndexOf("event:run_end"));
    expect(r.replies().at(-1)).toMatchObject({ type: "ok", text: "aborted" });
    // run_start comes first and run_end last, with the tool activity between them.
    const events = r.events();
    expect(events[0]).toBe("run_start");
    expect(events.at(-1)).toBe("run_end");
    expect(events).toContain("tool_start");
  });

  test("3. a second prompt while busy is refused, not silently queued", async () => {
    const r = rig([[{ type: "text", delta: "a" }], [{ type: "done", stop: "end" }]], [], 40);
    r.send({ type: "prompt", text: "first" });
    r.send({ type: "prompt", text: "second" });
    expect(r.replies()[1]).toMatchObject({ type: "error", detail: "a run is in progress: use steer or follow_up" });
    await r.settle();
  });

  test("4. steer and follow_up without a run are errors", () => {
    const r = rig([[{ type: "text", delta: "x" }]]);
    r.send({ type: "steer", text: "too early" });
    r.send({ type: "follow_up", text: "also early" });
    r.send({ type: "steer", text: "  " });
    expect(r.replies()[0]?.detail).toBe("no run in progress");
    expect(r.replies()[1]?.detail).toBe("no run in progress");
    expect(r.replies()[2]?.detail).toBe("steer needs text");
  });

  test("5. get_state reports the model, the message count and whether a run is live", async () => {
    const r = rig([[{ type: "text", delta: "x" }], [{ type: "done", stop: "end" }]], [], 30);
    r.send({ type: "get_state", id: "s1" });
    expect(r.replies()[0]).toMatchObject({ type: "ok", id: "s1", state: { running: false, model: "rpc-model", messages: 0 } });
    r.send({ type: "prompt", text: "go" });
    r.send({ type: "get_state", id: "s2" });
    const live = r.replies().find((l) => l.id === "s2");
    expect(live?.state?.running).toBe(true);
    await r.settle();
    r.send({ type: "get_state", id: "s3" });
    expect(r.replies().find((l) => l.id === "s3")?.state?.running).toBe(false);
  });

  test("5b. get_messages returns the conversation; a prompt's images reach its message; get_state names the session", async () => {
    const lines: Parsed[] = [];
    const { stream } = scripted([[{ type: "text", delta: "a cat" }, { type: "done", stop: "end" }]]);
    const agent = new Agent({ provider: { stream }, model: "m", system: "", tools: [], maxTurns: 8, maxCost: 10 });
    const rpc = new Rpc({ agent, model: "m", session: "s-9", cwd: "/p", write: (text) => lines.push(...parse(text)) });
    const img = { mime: "image/png", data: "QUJD" };
    rpc.handle(JSON.stringify({ type: "prompt", text: "what is this?", images: [img, { bad: 1 }] }));
    // oxlint-disable-next-line no-await-in-loop -- polling is the point
    for (let i = 0; i < 60 && agent.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    rpc.handle(JSON.stringify({ type: "get_messages", id: "m" }));
    rpc.handle(JSON.stringify({ type: "get_state", id: "s" }));
    const replies = lines.filter((l) => l.type !== "event") as RpcReply[];
    const messages = replies.find((r) => r.id === "m")?.messages ?? [];
    expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "what is this?"], ["assistant", "a cat"]]);
    expect(messages[0]?.images).toEqual([img]);
    expect(replies.find((r) => r.id === "s")?.state).toMatchObject({ session: "s-9", cwd: "/p" });
  });

  test("6. bad input is answered, never thrown at the caller", () => {
    const r = rig([[{ type: "text", delta: "x" }]]);
    r.rpc.handle("not json at all");
    r.rpc.handle('{"no":"type"}');
    r.rpc.handle('{"type":"nope"}');
    r.send({ type: "prompt", text: "   " });
    expect(r.replies().map((l) => l.detail)).toEqual([
      "not JSON: not json at all",
      'expected {"type": "...", "text": "..."}',
      "unknown command: nope",
      "prompt needs text",
    ]);
  });

  test("7. an aborted run reports the partial message BEFORE run_end", async () => {
    const r = rig([[{ type: "text", delta: "half" }], [{ type: "done", stop: "end" }]], [], 30);
    r.send({ type: "prompt", text: "go" });
    await new Promise((r2) => setTimeout(r2, 10));
    r.send({ type: "abort" });
    await r.settle();
    const events = r.events();
    // A client renders these in order: the message it paints must arrive before the run closes.
    // (queue_change may follow it, because aborting clears the dropped queues.)
    expect(events.at(-1)).toBe("run_end");
    expect(events.indexOf("message_end")).toBeGreaterThan(-1);
    expect(events.indexOf("message_end")).toBeLessThan(events.indexOf("run_end"));
    expect(r.agent.messages.at(-1)?.stop).toBe("aborted");
  });

  test("8. every line out is one complete JSON object", async () => {
    const r = rig([[{ type: "text", delta: "one\ntwo" }, { type: "done", stop: "end" }]]);
    r.send({ type: "prompt", text: "go" });
    await r.settle();
    for (const line of r.lines) expect(line.type).toMatch(/event|ok|error/);
    const textDeltas = r.lines.filter((l) => l.event?.type === "message_delta");
    expect(textDeltas).toHaveLength(1); // newlines inside content never split a line
  });
});