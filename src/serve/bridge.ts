// The Telegram bridge, in the hub: one paired private chat ↔ the hub's agents. It long-polls the bot
// (one consumer per bot, which is why it lives here and not in an extension), rereads
// integrations.json when it changes, and:
//   - tells when a run ends (notify on; aborted runs stay quiet), with the reply;
//   - takes text as a prompt (a reply to one of its messages goes to that agent; a steer mid-run);
//   - answers /agents /new /stop /status /compact /models /help;
//   - asks approvals with buttons, and edits the message when anyone answers.

import { stat } from "node:fs/promises";
import type { ApprovalBy } from "../approvals.ts";
import { integrationsFile, readIntegrations } from "../integrations.ts";
import type { TelegramSettings } from "../integrations.ts";
import type { AgentEvent } from "../loop.ts";
import type { AgentInfo, Agents, StartOptions } from "./agents.ts";
import { HELP, agentsText, answeredText, approvalText, endedText, stateWord } from "./bridge-text.ts";
import type { Project } from "./projects.ts";
import { Telegram, escapeHtml } from "./telegram.ts";
import type { TgButtons, TgCallback, TgMessage, TgUpdate } from "./telegram.ts";

export interface BridgeOptions {
  home: string;
  agents: Pick<Agents, "list" | "info" | "send"> & { start: (opts: StartOptions) => AgentInfo };
  projects: () => Promise<Project[]>;
  apiBase?: string;
  log: (line: string) => void;
  /** Seconds a getUpdates waits (Telegram allows 50); tests use less. */
  poll?: number;
  /** How often to look again while the bot is off or not set up. */
  idleMs?: number;
}

/** Messages older than this when the hub reads them (sent while it was down) are not obeyed. */
const STALE_S = 300;

export class Bridge {
  #o: BridgeOptions;
  #settings: TelegramSettings | undefined;
  #mtime = -1;
  #reading: Promise<void> = Promise.resolve();
  #api: Telegram | undefined;
  #commandsFor = "";
  #offset: number | undefined;
  #selected: string | undefined;
  /** Our messages → the agent they are about: a reply to one goes to it. */
  #about = new Map<number, string>();
  #runs = new Map<string, { started: number; reply: string }>();
  #fromChat = new Set<string>(); // runs started from the chat: their end is told even with notify off
  #asks = new Map<string, Promise<{ message: number; text: string } | undefined>>();
  #pending: string | undefined; // text waiting for "which agent?"
  #choices: string[] = []; // the last list of buttons' values (projects, models)
  #strangers = new Set<number>();

  constructor(opts: BridgeOptions) {
    this.#o = opts;
  }

  /** The settings, read again when the file changed (callers at the same time share one read). */
  async #current(): Promise<TelegramSettings | undefined> {
    const mtime = await stat(integrationsFile(this.#o.home)).then((s) => s.mtimeMs).catch(() => 0);
    if (mtime !== this.#mtime) {
      this.#mtime = mtime;
      this.#reading = readIntegrations(this.#o.home).then(({ telegram }) => {
        this.#settings = telegram;
        this.#api = telegram ? new Telegram(telegram.token, this.#o.apiBase) : undefined;
      });
    }
    await this.#reading;
    return this.#settings?.on && this.#settings.chat !== undefined ? this.#settings : undefined;
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let failing = false;
    while (!signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- one poll round at a time
      const t = await this.#current();
      const api = this.#api;
      if (t === undefined || api === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- waiting for the bot to be set up
        await sleep(this.#o.idleMs ?? 5000, signal);
        continue;
      }
      if (this.#commandsFor !== t.token) {
        this.#commandsFor = t.token;
        this.#o.log(`telegram: @${t.bot} with ${t.name ?? "your chat"}`);
        const list = [["agents", "Pick an agent"], ["new", "Start an agent in a project"], ["status", "What the selected agent does"], ["stop", "Stop its run"], ["compact", "Summarize its history"], ["models", "Switch its model"], ["help", "What I do"]];
        void api.setMyCommands(list.map(([command, description]) => ({ command: command!, description: description! })), signal).catch(() => undefined);
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- long polling: one request at a time
        const updates = await api.getUpdates(this.#offset, this.#o.poll ?? 50, signal);
        failing = false;
        for (const u of updates) {
          this.#offset = u.update_id + 1;
          // oxlint-disable-next-line no-await-in-loop -- in the order they were sent
          await this.#update(u, t, api, signal).catch((e: unknown) => this.#o.log(`telegram: ${e instanceof Error ? e.message : String(e)}`));
        }
      } catch (e) {
        if (signal.aborted) return;
        if (!failing) this.#o.log(`telegram: ${e instanceof Error ? e.message : String(e)} (trying again)`);
        failing = true;
        // oxlint-disable-next-line no-await-in-loop -- a pause before trying again
        await sleep(5000, signal);
      }
    }
  }

  /** An agent's event, from the hub. */
  event(agent: string, e: AgentEvent): void {
    if (e.type === "run_start") this.#runs.set(agent, { started: Date.now(), reply: "" });
    else if (e.type === "message_end" && e.message.role === "assistant" && e.message.content.trim() !== "") {
      const run = this.#runs.get(agent);
      if (run) run.reply = e.message.content;
    } else if (e.type === "run_end") void this.#ended(agent, e.reason, e.detail);
    else if (e.type === "approval_request") this.#asks.set(e.id, this.#ask(agent, e.id, e.call as { name: string; args: Record<string, unknown> }, e.reason));
    else if (e.type === "approval_end") void this.#answered(e.id, e.allow, e.by);
  }

  async #ended(agent: string, reason: string, detail?: string): Promise<void> {
    const run = this.#runs.get(agent);
    this.#runs.delete(agent);
    const asked = this.#fromChat.delete(agent);
    const t = await this.#current();
    const info = this.#o.agents.info(agent);
    if (!t || !info || reason === "aborted" || !(t.notify || asked)) return;
    const sent = await this.#send(t, endedText(info, reason, Date.now() - (run?.started ?? Date.now()), run?.reply ?? "", detail));
    if (sent) this.#remember(sent.message_id, agent);
    this.#selected = agent;
  }

  async #ask(agent: string, id: string, call: { name: string; args: Record<string, unknown> }, reason: string): Promise<{ message: number; text: string } | undefined> {
    const t = await this.#current();
    if (!t?.approvals) return undefined;
    const text = approvalText(this.#o.agents.info(agent)?.project ?? agent, call, reason);
    const key = (answer: string): string => `ap:${answer}:${agent}:${id}`;
    const buttons: TgButtons = [[{ text: "✅ Allow", callback_data: key("y") }, { text: "❌ Deny", callback_data: key("n") }], [{ text: "✅ This session", callback_data: key("s") }]];
    const sent = await this.#send(t, text, buttons);
    if (sent) this.#remember(sent.message_id, agent);
    return sent ? { message: sent.message_id, text } : undefined;
  }

  async #answered(id: string, allow: boolean, by: ApprovalBy): Promise<void> {
    const asked = await this.#asks.get(id);
    this.#asks.delete(id);
    const t = await this.#current();
    if (!asked || !t || t.chat === undefined) return;
    await this.#api?.editMessageText(t.chat, asked.message, answeredText(asked.text, allow, by), AbortSignal.timeout(10_000)).catch(() => undefined);
  }

  async #update(u: TgUpdate, t: TelegramSettings, api: Telegram, signal: AbortSignal): Promise<void> {
    if (u.callback_query) return this.#button(u.callback_query, t, api, signal);
    const m = u.message;
    if (m === undefined || m.text === undefined) return;
    if (m.chat.id !== t.chat) {
      if (!this.#strangers.has(m.chat.id)) this.#o.log(`telegram: ignoring chat ${m.chat.id} (not the paired one)`);
      this.#strangers.add(m.chat.id);
      return;
    }
    if (m.date !== undefined && Date.now() / 1000 - m.date > STALE_S) return;
    if (!t.prompts) return void this.#send(t, "Prompts from Telegram are off (kinoko: /integrations).");
    const text = m.text.trim();
    if (text.startsWith("/")) return this.#command(text, t);
    const about = m.reply_to_message ? this.#about.get(m.reply_to_message.message_id) : undefined;
    const target = about ?? this.#selected;
    if (target === undefined || this.#o.agents.info(target) === undefined) {
      this.#pending = text;
      return void this.#send(t, "Which agent?", this.#agentButtons());
    }
    await this.#deliver(target, text, t);
  }

  async #deliver(agent: string, text: string, t: TelegramSettings): Promise<void> {
    const info = this.#o.agents.info(agent);
    if (!info) return;
    this.#selected = agent;
    const busy = info.state === "running" || info.state === "starting";
    if (!busy) this.#fromChat.add(agent);
    const reply = await this.#o.agents.send(agent, { type: busy ? "steer" : "prompt", text });
    if (reply.type !== "ok") {
      this.#fromChat.delete(agent);
      return void this.#send(t, `⚠️ ${escapeHtml(reply.detail ?? "refused")}`);
    }
    const sent = await this.#send(t, busy ? `↪ sent to <b>${escapeHtml(info.project)}</b> as a steer` : `▶ <b>${escapeHtml(info.project)}</b> is on it`);
    if (sent) this.#remember(sent.message_id, agent);
  }

  async #command(text: string, t: TelegramSettings): Promise<void> {
    const [name = "", ...rest] = text.slice(1).split(/\s+/);
    const command = name.replace(/@\w+$/, "").toLowerCase();
    const arg = rest.join(" ");
    const target = this.#selected !== undefined && this.#o.agents.info(this.#selected) ? this.#selected : undefined;
    const needs = async (): Promise<string | undefined> => {
      if (target === undefined) await this.#send(t, "No agent selected: /agents or /new.");
      return target;
    };
    if (command === "start" || command === "help") return void this.#send(t, HELP);
    if (command === "agents") return void this.#send(t, agentsText(this.#o.agents.list(), target), this.#agentButtons());
    if (command === "new") return this.#new(arg, t);
    const agent = await needs();
    if (agent === undefined) return;
    const info = this.#o.agents.info(agent)!;
    if (command === "status") return void this.#send(t, `<b>${escapeHtml(info.project)}</b> · ${stateWord(info)}${info.title ? `\n${escapeHtml(info.title)}` : ""}${info.last ? `\n\n${escapeHtml(info.last)}` : ""}`);
    if (command === "stop") {
      await this.#o.agents.send(agent, { type: "abort" });
      return void this.#send(t, `⏹ stopping <b>${escapeHtml(info.project)}</b>`);
    }
    if (command !== "compact" && command !== "models") return void this.#send(t, `I do not know /${escapeHtml(command)}.\n\n${HELP}`);
    const reply = await this.#o.agents.send(agent, { type: "command", name: command, arg });
    const result = reply.result;
    if (reply.type !== "ok" || !result) return void this.#send(t, `⚠️ ${escapeHtml(reply.detail ?? "refused")}`);
    if (command === "models" && result.items && arg === "") {
      this.#choices = result.items.map((i) => i.name);
      const buttons = result.items.slice(0, 10).map((item, i) => [{ text: `${item.current ? "● " : ""}${item.name.split("/").at(-1)?.replace(/\.gguf$/, "") ?? item.name}`, callback_data: `mod:${i}` }]);
      return void this.#send(t, "Which model?", buttons);
    }
    await this.#send(t, escapeHtml(result.text ?? "done"));
  }

  async #new(arg: string, t: TelegramSettings): Promise<void> {
    const projects = await this.#o.projects();
    const wanted = arg.toLowerCase();
    const match = wanted === "" ? undefined : (projects.find((p) => p.name.toLowerCase() === wanted) ?? projects.find((p) => p.name.toLowerCase().startsWith(wanted)));
    if (match) return this.#start(match.cwd, t);
    this.#choices = projects.slice(0, 10).map((p) => p.cwd);
    if (this.#choices.length === 0) return void this.#send(t, "No projects yet: kinoko lists the folders it has worked in.");
    await this.#send(t, wanted === "" ? "Start an agent in:" : `No project “${escapeHtml(arg)}”. Start one in:`, projects.slice(0, 10).map((p, i) => [{ text: p.name, callback_data: `new:${i}` }]));
  }

  async #start(cwd: string, t: TelegramSettings): Promise<void> {
    const info = this.#o.agents.start({ cwd });
    this.#selected = info.id;
    const sent = await this.#send(t, `🍄 started in <b>${escapeHtml(info.project)}</b>: tell me what to do`);
    if (sent) this.#remember(sent.message_id, info.id);
  }

  async #button(q: TgCallback, t: TelegramSettings, api: Telegram, signal: AbortSignal): Promise<void> {
    if (q.from.id !== t.chat && q.message?.chat.id !== t.chat) return;
    const [kind = "", a = "", b = "", c = ""] = (q.data ?? "").split(":");
    let note: string | undefined;
    if (kind === "ap") {
      const reply = await this.#o.agents.send(b, { type: "approve", request: c, allow: a !== "n", remember: a === "s", by: "telegram" });
      note = reply.type === "ok" ? (a === "n" ? "denied" : "allowed") : "already answered";
    } else if (kind === "sel" && this.#o.agents.info(a)) {
      this.#selected = a;
      note = `${this.#o.agents.info(a)?.project}`;
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending !== undefined) await this.#deliver(a, pending, t);
    } else if (kind === "new" && this.#choices[Number(a)] !== undefined) {
      await this.#start(this.#choices[Number(a)]!, t);
    } else if (kind === "mod" && this.#selected && this.#choices[Number(a)] !== undefined) {
      const reply = await this.#o.agents.send(this.#selected, { type: "command", name: "models", arg: this.#choices[Number(a)]! });
      note = reply.result?.text ?? reply.detail;
    }
    await api.answerCallbackQuery(q.id, signal, note?.slice(0, 190)).catch(() => undefined);
  }

  #agentButtons(): TgButtons {
    return this.#o.agents.list().filter((a) => a.state !== "exited").slice(0, 10).map((a) => [{ text: `${a.project} · ${stateWord(a)}`, callback_data: `sel:${a.id}` }]);
  }

  #remember(message: number, agent: string): void {
    this.#about.set(message, agent);
    if (this.#about.size > 500) this.#about.delete(this.#about.keys().next().value!);
  }

  async #send(t: TelegramSettings, text: string, buttons?: TgButtons): Promise<TgMessage | undefined> {
    if (t.chat === undefined || this.#api === undefined) return undefined;
    return this.#api.sendMessage(t.chat, text, AbortSignal.timeout(15_000), buttons && buttons.length > 0 ? { buttons } : {}).catch((e: unknown) => {
      this.#o.log(`telegram: could not send (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });
}
