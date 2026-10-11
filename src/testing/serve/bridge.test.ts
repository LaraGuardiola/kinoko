import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTelegram } from "../../integrations.ts";
import type { TelegramSettings } from "../../integrations.ts";
import type { RpcCommand, RpcReply } from "../../rpc.ts";
import type { AgentInfo, StartOptions } from "../../serve/agents.ts";
import { Bridge } from "../../serve/bridge.ts";
import { GOOD_TOKEN, fakeTelegram, said } from "./fake-telegram.ts";
import type { FakeTelegram } from "./fake-telegram.ts";

const CHAT = 777;
const home = mkdtempSync(join(tmpdir(), "kinoko-bridge-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function agent(id: string, project: string, state: AgentInfo["state"] = "idle"): AgentInfo {
  return { id, origin: "app", cwd: `/p/${project}`, project, model: "m", state, started: 0, activity: 0 };
}

/** A hub's agents: what was sent to each, and what was started. */
function fakeAgents(list: AgentInfo[]) {
  const sent: Array<{ agent: string; command: RpcCommand }> = [];
  const started: StartOptions[] = [];
  let approved = false;
  return {
    sent,
    started,
    list: () => list,
    info: (id: string) => list.find((a) => a.id === id),
    send: async (id: string, command: RpcCommand): Promise<RpcReply> => {
      sent.push({ agent: id, command });
      if (command.type === "approve") {
        const first = !approved;
        approved = true;
        return first ? { type: "ok", text: "allowed" } : { type: "error", detail: "not waiting: already answered" };
      }
      if (command.type === "command" && command.name === "models" && !command.arg) return { type: "ok", result: { items: [{ name: "/m/qwen.gguf", description: "", current: true }, { name: "gpt-5", description: "" }] } };
      if (command.type === "command") return { type: "ok", result: { text: `ran ${command.name} ${command.arg ?? ""}`.trim() } };
      return { type: "ok", text: "started" };
    },
    start: (opts: StartOptions): AgentInfo => {
      started.push(opts);
      const info = agent("n1", opts.cwd.split("/").at(-1) ?? "", "starting");
      list.push(info);
      return info;
    },
  };
}

let tg: FakeTelegram;
let stop: AbortController;

beforeEach(() => {
  tg = fakeTelegram();
  stop = new AbortController();
});
afterEach(() => {
  stop.abort();
  tg.stop();
});

async function setup(list: AgentInfo[], settings: Partial<TelegramSettings> = {}): Promise<{ bridge: Bridge; agents: ReturnType<typeof fakeAgents>; logs: string[] }> {
  await setTelegram(home, () => ({ token: GOOD_TOKEN, bot: "kinoko_test_bot", chat: CHAT, name: "Lara", notify: true, prompts: true, approvals: true, on: true, ...settings }));
  const agents = fakeAgents(list);
  const logs: string[] = [];
  const bridge = new Bridge({ home, agents, projects: async () => [{ cwd: "/p/kinoko", name: "kinoko", updated: 0, sessions: [] }, { cwd: "/p/web", name: "web", updated: 0, sessions: [] }], apiBase: tg.base, log: (l) => logs.push(l), poll: 1, idleMs: 20 });
  void bridge.run(stop.signal);
  return { bridge, agents, logs };
}

/** The texts sent to the chat so far. */
const texts = (): string[] => tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));

async function until(check: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- polling is the point
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

const button = (data: string) => ({ callback_query: { id: "q", from: { id: CHAT }, message: { message_id: 1, chat: { id: CHAT, type: "private" } }, data } });

describe("serve: the Telegram bridge", () => {
  test("a run that ends is told with its reply as HTML; an aborted one stays quiet; a reply to it prompts that agent", async () => {
    const { bridge, agents } = await setup([agent("a1", "kinoko"), agent("a2", "web")]);
    bridge.event("a1", { type: "run_start", prompt: "x" });
    bridge.event("a1", { type: "message_end", message: { id: "m", role: "assistant", content: "Done: `x` <ok>\n```ts\nlet a = 1 < 2;\n```" } });
    bridge.event("a1", { type: "run_end", reason: "done" });
    await until(() => texts().length === 1);
    expect(texts()[0]).toBe("🍄 <b>kinoko</b> · done in 0s\n\nDone: <code>x</code> &lt;ok&gt;\n<pre>let a = 1 &lt; 2;</pre>");
    const toldAbout = tg.calls.findIndex((c) => c.method === "sendMessage") + 1; // the fake's message_id
    bridge.event("a1", { type: "run_start", prompt: "y" });
    bridge.event("a1", { type: "run_end", reason: "aborted" });
    await new Promise((r) => setTimeout(r, 50));
    expect(texts().length).toBe(1);
    // web ends after it: web is selected now, but a reply to kinoko's message goes to kinoko.
    bridge.event("a2", { type: "run_start", prompt: "z" });
    bridge.event("a2", { type: "run_end", reason: "done" });
    await until(() => texts().length === 2);
    tg.push({ message: { message_id: 9, chat: { id: CHAT, type: "private" }, text: "and now tests", reply_to_message: { message_id: toldAbout, chat: { id: CHAT, type: "private" } } } });
    await until(() => agents.sent.some((s) => s.command.type === "prompt"));
    expect(agents.sent.find((s) => s.command.type === "prompt")).toEqual({ agent: "a1", command: { type: "prompt", text: "and now tests" } });
  });

  test("notify off: only runs started from the chat are told", async () => {
    const { bridge } = await setup([agent("a1", "kinoko")], { notify: false });
    bridge.event("a1", { type: "run_start", prompt: "x" });
    bridge.event("a1", { type: "run_end", reason: "done" });
    await new Promise((r) => setTimeout(r, 60));
    expect(texts()).toEqual([]);
    tg.push(said("hola", CHAT));
    await until(() => texts().includes("Which agent?"));
    tg.push(button("sel:a1"));
    await until(() => texts().some((t) => t.includes("is on it")));
    bridge.event("a1", { type: "run_start", prompt: "hola" });
    bridge.event("a1", { type: "run_end", reason: "error", detail: "boom" });
    await until(() => texts().some((t) => t.includes("failed: boom")));
  });

  test("text with no agent selected asks which; the pick sends it; a running agent gets a steer", async () => {
    const list = [agent("a1", "kinoko"), agent("a2", "web", "running")];
    const { agents } = await setup(list);
    tg.push(said("hola", CHAT));
    await until(() => texts().includes("Which agent?"));
    const asked = tg.calls.find((c) => c.body.text === "Which agent?")!;
    expect(JSON.stringify(asked.body.reply_markup)).toContain("sel:a2");
    tg.push(button("sel:a2"));
    await until(() => agents.sent.length === 1);
    expect(agents.sent[0]).toEqual({ agent: "a2", command: { type: "steer", text: "hola" } });
    await until(() => texts().some((t) => t.includes("as a steer")));
    expect(tg.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  test("another chat is ignored (logged once); prompts off says so", async () => {
    const { agents, logs } = await setup([agent("a1", "kinoko")], { prompts: false });
    tg.push(said("hola", 999));
    tg.push(said("again", 999));
    tg.push(said("hola", CHAT));
    await until(() => texts().length === 1);
    expect(texts()[0]).toContain("Prompts from Telegram are off");
    expect(agents.sent).toEqual([]);
    expect(logs.filter((l) => l.includes("999")).length).toBe(1);
  });

  test("commands: /agents, /new by name and by button, /stop, /compact, /models and a pick", async () => {
    const { agents } = await setup([agent("a1", "kinoko", "running")]);
    tg.push(said("/agents", CHAT));
    await until(() => texts().some((t) => t.includes("<b>kinoko</b> working")));
    tg.push(said("/new web", CHAT));
    await until(() => agents.started.length === 1);
    expect(agents.started[0]).toEqual({ cwd: "/p/web" });
    await until(() => texts().some((t) => t.includes("started in <b>web</b>")));
    tg.push(said("/new", CHAT));
    await until(() => texts().includes("Start an agent in:"));
    tg.push(button("new:0"));
    await until(() => agents.started.length === 2);
    expect(agents.started[1]).toEqual({ cwd: "/p/kinoko" });
    tg.push(button("sel:a1"));
    tg.push(said("/stop", CHAT));
    await until(() => agents.sent.some((s) => s.command.type === "abort"));
    tg.push(said("/compact", CHAT));
    await until(() => texts().includes("ran compact"));
    tg.push(said("/models", CHAT));
    await until(() => texts().includes("Which model?"));
    expect(JSON.stringify(tg.calls.findLast((c) => c.body.text === "Which model?")?.body.reply_markup)).toContain("● qwen");
    tg.push(button("mod:1"));
    await until(() => agents.sent.some((s) => s.command.type === "command" && s.command.arg === "gpt-5"));
  });

  test("approvals: buttons; a tap answers by telegram; the message is edited to the outcome, also when another client answered", async () => {
    const { bridge, agents } = await setup([agent("a1", "kinoko", "running")]);
    const call = { id: "c", name: "bash", args: { command: "sudo ls" } };
    bridge.event("a1", { type: "approval_request", id: "q1", call, reason: "sudo needs confirmation" });
    await until(() => texts().length === 1);
    expect(texts()[0]).toBe("🔐 <b>kinoko</b> wants to run:\n<pre>sudo ls</pre>\nsudo needs confirmation");
    expect(JSON.stringify(tg.calls[tg.calls.length - 1]?.body.reply_markup)).toContain("ap:s:a1:q1");
    tg.push(button("ap:y:a1:q1"));
    await until(() => agents.sent.some((s) => s.command.type === "approve"));
    expect(agents.sent[0]?.command).toEqual({ type: "approve", request: "q1", allow: true, remember: false, by: "telegram" });
    bridge.event("a1", { type: "approval_end", id: "q1", allow: true, by: "telegram" });
    await until(() => tg.calls.some((c) => c.method === "editMessageText"));
    expect(String(tg.calls.find((c) => c.method === "editMessageText")?.body.text)).toEndWith("✅ allowed here");

    bridge.event("a1", { type: "approval_request", id: "q2", call, reason: "again" });
    await until(() => texts().length === 2);
    bridge.event("a1", { type: "approval_end", id: "q2", allow: false, by: "tui" });
    await until(() => tg.calls.filter((c) => c.method === "editMessageText").length === 2);
    expect(String(tg.calls.findLast((c) => c.method === "editMessageText")?.body.text)).toEndWith("❌ denied from the terminal");
  });

  test("switched off or not paired: no polling at all", async () => {
    await setup([], { on: false });
    await new Promise((r) => setTimeout(r, 80));
    expect(tg.calls.filter((c) => c.method === "getUpdates")).toEqual([]);
  });
});
