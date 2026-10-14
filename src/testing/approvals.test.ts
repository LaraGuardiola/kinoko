import { describe, expect, test } from "bun:test";
import { Extensions } from "../ext.ts";
import { Agent } from "../loop.ts";
import type { AgentEvent } from "../agent-events.ts";
import type { Message, Provider, StreamEvent, Tool } from "../types.ts";

/** A model that calls `bash` with each command in turn (one per reply); "" or none says "done". */
function caller(commands: string[]): Provider {
  let turn = 0;
  return {
    stream: async function* (): AsyncIterable<StreamEvent> {
      const command = commands[turn++];
      if (command === undefined || command === "") {
        yield { type: "text", delta: "done" };
        yield { type: "done", stop: "end" };
        return;
      }
      yield { type: "tool_call", call: { id: `c${turn}`, name: "bash", args: { command } } };
      yield { type: "done", stop: "tool_use" };
    },
  } as unknown as Provider;
}

/** A fake bash that records what it ran. */
function bash(ran: string[]): Tool {
  return {
    name: "bash",
    description: "",
    schema: {},
    readOnly: false,
    run: async (args: unknown) => {
      ran.push(String((args as { command: string }).command));
      return "ran";
    },
  } as unknown as Tool;
}

/** An agent whose extension asks about every `sudo`, its events and what its bash ran. */
function setup(commands: string[], approvalTimeoutMs = 60_000): { agent: Agent; events: AgentEvent[]; ran: string[] } {
  const ext = new Extensions(() => undefined);
  ext.on("tool_call", (call) => (String(call.args.command).startsWith("sudo") ? { ask: true, reason: "sudo needs confirmation" } : undefined));
  const ran: string[] = [];
  const agent = new Agent({ provider: caller(commands), model: "t", system: "", tools: [bash(ran)], maxTurns: 10, maxCost: 100, extensions: ext, approvalTimeoutMs });
  const events: AgentEvent[] = [];
  agent.on((e) => events.push(e));
  return { agent, events, ran };
}

/** The next approval_request's id, once it is out. */
async function requested(events: AgentEvent[], nth = 0): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const asks = events.filter((e) => e.type === "approval_request");
    const ask = asks[nth];
    if (ask?.type === "approval_request") return ask.id;
    // oxlint-disable-next-line no-await-in-loop -- polling for the event is the point
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("no approval_request");
}

const toolResults = (messages: Message[]): string[] => messages.filter((m) => m.role === "tool").map((m) => m.content);

describe("approvals", () => {
  test("allow runs the tool; the request names the call and the reason", async () => {
    const { agent, events, ran } = setup(["sudo ls"]);
    const run = agent.prompt("go");
    const id = await requested(events);
    const ask = events.find((e) => e.type === "approval_request");
    expect(ask?.type === "approval_request" && ask.reason).toBe("sudo needs confirmation");
    expect(ask?.type === "approval_request" && ask.call.args).toEqual({ command: "sudo ls" });
    expect(agent.approve(id, true, { by: "app" })).toBe(true);
    expect(agent.approve(id, false)).toBe(false); // the first answer wins
    expect((await run).reason).toBe("done");
    expect(ran).toEqual(["sudo ls"]);
    expect(events.find((e) => e.type === "approval_end")).toEqual({ type: "approval_end", id, allow: true, by: "app" });
  });

  test("deny gives an ERROR result and the tool never runs", async () => {
    const { agent, events, ran } = setup(["sudo rm x"]);
    const run = agent.prompt("go");
    agent.approve(await requested(events), false);
    await run;
    expect(ran).toEqual([]);
    expect(toolResults(agent.messages)).toEqual(["ERROR: denied by the user: it did not run"]);
  });

  test("an abort mid-wait denies within 100 ms", async () => {
    const { agent, events, ran } = setup(["sudo ls"]);
    const run = agent.prompt("go");
    await requested(events);
    const at = Date.now();
    agent.abort();
    expect((await run).reason).toBe("aborted");
    expect(Date.now() - at).toBeLessThan(100);
    expect(ran).toEqual([]);
    expect(toolResults(agent.messages)).toEqual(["Aborted by user"]);
    expect(events.find((e) => e.type === "approval_end")).toMatchObject({ allow: false, by: "abort" });
  });

  test("the timeout denies; 0 denies at once (nobody to ask)", async () => {
    const { agent, events } = setup(["sudo ls"], 20);
    await agent.prompt("go");
    expect(toolResults(agent.messages)[0]).toStartWith("ERROR: denied");
    expect(events.find((e) => e.type === "approval_end")).toMatchObject({ allow: false, by: "timeout" });
    const none = setup(["sudo ls"], 0);
    await none.agent.prompt("go");
    expect(none.ran).toEqual([]);
  });

  test("this session: the same command is not asked again, another one is; a new session forgets", async () => {
    const { agent, events, ran } = setup(["sudo  ls", "sudo ls", "sudo pwd", "", "sudo ls"]);
    const run = agent.prompt("go");
    agent.approve(await requested(events), true, { remember: true });
    agent.approve(await requested(events, 1), true); // sudo pwd: asked
    await run;
    expect(ran).toEqual(["sudo  ls", "sudo ls", "sudo pwd"]);
    expect(events.filter((e) => e.type === "approval_request").length).toBe(2);
    agent.restart(); // /new
    const next = agent.prompt("again");
    agent.approve(await requested(events, 2), false);
    await next;
    expect(ran.length).toBe(3);
  });

  test("every tool call ends with exactly one result, whatever the answer", async () => {
    const { agent, events } = setup(["sudo a", "ls", "sudo b"]);
    const run = agent.prompt("go");
    agent.approve(await requested(events), false);
    agent.approve(await requested(events, 1), true);
    await run;
    const calls = agent.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
    const results = agent.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(results).toEqual(calls);
    expect(toolResults(agent.messages)).toEqual(["ERROR: denied by the user: it did not run", "ran", "ran"]);
  });

  test("a block wins over an ask from an earlier handler, and says which extension decided", async () => {
    const ext = new Extensions(() => undefined);
    await ext.start("asker", (k) => k.on("tool_call", () => ({ ask: true, reason: "ask" })));
    await ext.start("blocker", (k) => k.on("tool_call", () => ({ block: true, reason: "never" })));
    expect(ext.beforeTool({ name: "bash", args: {}, signal: new AbortController().signal })).toEqual({ block: true, reason: "never", by: "blocker" });
  });

  test("auto approve (a profile that asks nothing): an ask runs at once, unasked; a block still blocks", async () => {
    const { agent, events, ran } = setup(["sudo ls"]);
    agent.setAutoApprove(true);
    await agent.prompt("go");
    expect(ran).toEqual(["sudo ls"]);
    expect(events.some((e) => e.type === "approval_request")).toBe(false);
    const ext = new Extensions(() => undefined);
    ext.on("tool_call", () => ({ block: true, reason: "hardline" }));
    const blocked: string[] = [];
    const strict = new Agent({ provider: caller(["rm -rf /"]), model: "t", system: "", tools: [bash(blocked)], maxTurns: 5, maxCost: 1, extensions: ext });
    strict.setAutoApprove(true);
    await strict.prompt("go");
    expect(blocked).toEqual([]);
    expect(strict.messages.find((m) => m.role === "tool")?.content).toBe("hardline");
  });
});
