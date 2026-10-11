// /integrations: one page per integration (Telegram for now), and Telegram's setup step by step:
// create the bot, paste its token (checked with getMe), pair the chat with a one-use code, then the
// options. Everything lands in ~/.kinoko/integrations.json; `kinoko serve` runs the bot.

import { hostname } from "node:os";
import { readIntegrations, setTelegram } from "../integrations.ts";
import type { TelegramSettings } from "../integrations.ts";
import { Telegram, TelegramError, waitForPairing } from "../serve/telegram.ts";
import type { InfoPage, InputPage, ListPage, MenuItem, MenuPage } from "./menu.ts";
import { ANSI } from "./style.ts";

export interface IntegrationsHost {
  home: string;
  /** Telegram's address (a fake one in tests). */
  apiBase?: string;
  open: (page: MenuPage) => void;
  /** Replaces `from` with `to` while `from` is on screen, keeping the selection's place. */
  swap: (from: MenuPage, to: MenuPage) => void;
  /** A note above the input. */
  note: (text: string) => void;
  /** Whether `kinoko serve` runs (the bot answers only then). */
  hubRunning: () => Promise<boolean>;
  /** The telegram extension (files from the model to the chat): its state, and switching it on. */
  filesExtension?: {
    state: () => Promise<FilesState>;
    /** Installs it (the catalog fetched first) or switches it back on; a line saying what was done. */
    turnOn: () => Promise<string>;
  };
}

/** The telegram extension: loaded, installed but switched off, or not installed. */
export type FilesState = "on" | "off" | "missing";

const PAIRING_MS = 10 * 60_000;

/** The root page: each integration with its state (● on, ○ set up but off). */
export function openIntegrations(host: IntegrationsHost): void {
  const loading: ListPage = { kind: "list", title: "Integrations", items: [], empty: "reading…", pick: () => undefined };
  host.open(loading);
  void readIntegrations(host.home).then(({ telegram }) => {
    const ready = telegram?.chat !== undefined;
    host.swap(loading, {
      kind: "list",
      title: "Integrations",
      items: [
        {
          name: "telegram",
          description: !telegram ? "Not set up: talk to your agents from Telegram" : !ready ? "Set up, not paired yet" : `@${telegram.bot} with ${telegram.name ?? "your chat"}`,
          current: ready && telegram.on,
          off: ready && !telegram.on,
        },
      ],
      empty: "",
      stay: true, // Telegram's page opens over this one, once its settings are read
      pick: () => (ready ? openTelegram(host) : openSetup(host, telegram)),
    });
  });
}

/** Step 1: create the bot (or, with a token already saved, pair it). */
function openSetup(host: IntegrationsHost, saved: TelegramSettings | undefined): void {
  if (saved !== undefined) return pair(host, saved);
  host.open({
    kind: "info",
    title: "Telegram · 1/3 · create the bot",
    lines: [
      "  In Telegram, talk to @BotFather and send /newbot.",
      "  Pick a name, then a username ending in “bot”.",
      "  BotFather answers with a token: copy it.",
      "",
      `  ${ANSI.dim}Your replies and prompts will go through Telegram's servers.${ANSI.reset}`,
    ],
    hint: "Enter to continue · Esc to go back",
    next: () => host.open(tokenPage(host)),
  });
}

/** Step 2: the token, checked with getMe; a wrong one stays here and says why. */
function tokenPage(host: IntegrationsHost, why?: string): InputPage {
  return {
    kind: "input",
    title: "Telegram · 2/3 · the token",
    label: "token",
    hint: why ?? "paste the token BotFather gave you · Enter",
    secret: true,
    submit: (typed) => {
      const token = typed.trim();
      if (token === "") return;
      const stop = new AbortController();
      const checking: InfoPage = { kind: "info", title: "Telegram · 2/3 · the token", lines: ["  asking Telegram…"], leave: () => stop.abort() };
      host.open(checking);
      new Telegram(token, host.apiBase)
        .getMe(AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]))
        .then(async (me) => {
          const saved = await setTelegram(host.home, () => ({ token, bot: me.username ?? "", notify: true, prompts: true, approvals: true, on: true }));
          if (saved) pair(host, saved, checking);
        })
        .catch((e: unknown) => {
          if (stop.signal.aborted) return;
          const refused = e instanceof TelegramError && (e.status === 401 || e.status === 404);
          host.swap(checking, tokenPage(host, refused ? "Telegram says the token is not valid: paste it again" : `${e instanceof Error ? e.message : String(e)} · Enter to try again`));
        });
    },
  };
}

/** Step 3: a one-use code sent from the chat to pair; Esc stops the wait. */
function pair(host: IntegrationsHost, saved: TelegramSettings, from?: MenuPage): void {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  const stop = new AbortController();
  const page: InfoPage = {
    kind: "info",
    title: "Telegram · 3/3 · pair your chat",
    lines: [
      `  Bot: ${ANSI.cream}@${saved.bot}${ANSI.reset}`,
      `  Send ${ANSI.cream}/start ${code}${ANSI.reset} to it, or open ${ANSI.cream}https://t.me/${saved.bot}?start=${code}${ANSI.reset}`,
      `  ${ANSI.dim}waiting… the code works once, for ten minutes${ANSI.reset}`,
    ],
    hint: "Esc to stop waiting",
    leave: () => stop.abort(),
  };
  if (from) host.swap(from, page);
  else host.open(page);
  const api = new Telegram(saved.token, host.apiBase);
  waitForPairing(api, code, AbortSignal.any([stop.signal, AbortSignal.timeout(PAIRING_MS)]))
    .then(async (message) => {
      const name = message.from?.first_name ?? message.from?.username ?? "you";
      await setTelegram(host.home, (t) => (t ? { ...t, chat: message.chat.id, name } : t));
      await api.sendMessage(message.chat.id, `🍄 paired with ${hostname()}`, AbortSignal.timeout(10_000)).catch(() => undefined);
      host.note(`Telegram: paired with ${name}`);
      openTelegram(host, page);
    })
    .catch((e: unknown) => {
      if (stop.signal.aborted) return;
      const expired = e instanceof Error && e.name === "TimeoutError";
      host.swap(page, { kind: "info", title: "Telegram · 3/3 · pair your chat", lines: [`  ${expired ? "The code expired." : e instanceof Error ? e.message : String(e)}`], hint: "Enter to try again · Esc to go back", next: () => pair(host, saved) });
    });
}

/** The options: each toggled with Enter; a test message; Disconnect with Del twice. */
function openTelegram(host: IntegrationsHost, from?: MenuPage): void {
  void readIntegrations(host.home).then(({ telegram }) => {
    if (telegram === undefined) return;
    const page = optionsPage(host, telegram, "checking kinoko serve…", undefined);
    if (from) host.swap(from, page);
    else host.open(page);
    void Promise.all([host.hubRunning(), host.filesExtension?.state() ?? Promise.resolve(undefined)]).then(([running, files]) => host.swap(page, optionsPage(host, telegram, hubLine(running), files)));
  });
}

function filesItem(files: FilesState | undefined): MenuItem {
  const description =
    files === "on" ? "The model can send you files (the telegram extension)"
    : files === "off" ? "The telegram extension is switched off: Enter switches it on"
    : files === "missing" ? "Let the model send you files: Enter installs the telegram extension"
    : "checking the telegram extension…";
  return { name: "files", description, current: files === "on", off: files === "off" };
}

function hubLine(running: boolean): string {
  return running ? "kinoko serve is running: the bot answers" : "the bot answers while kinoko serve runs: it is not running now";
}

/** A switch: ● on, ○ off. */
function toggle(name: string, on: boolean, description: string): MenuItem {
  return { name, description, current: on, off: !on };
}

function optionsPage(host: IntegrationsHost, t: TelegramSettings, hub: string, files: FilesState | undefined): ListPage {
  const page: ListPage = {
    kind: "list",
    title: `Telegram · @${t.bot} · ${t.name ?? "paired"}`,
    items: [
      toggle("on", t.on, "The bot runs (while kinoko serve does)"),
      toggle("notify", t.notify, "Tell me when a run ends"),
      toggle("prompts", t.prompts, "Take prompts and commands from the chat"),
      toggle("approvals", t.approvals, "Ask approvals there too"),
      ...(host.filesExtension ? [filesItem(files)] : []),
      { name: "test", description: "Send a test message" },
      { name: "disconnect", description: "Forget the token and the chat (Del twice)", removable: true, key: "disconnect" },
    ],
    empty: "",
    stay: true,
    hint: hub,
    pick: (item) => {
      if (item.name === "files") {
        const ext = host.filesExtension;
        if (ext === undefined || files === undefined) return;
        if (files === "on") return host.note("Telegram: the telegram extension is on (/extensions manages it)");
        host.note(files === "missing" ? "installing the telegram extension…" : "switching the telegram extension on…");
        void ext
          .turnOn()
          .then(async (note) => {
            host.note(note);
            host.swap(page, optionsPage(host, t, hub, await ext.state()));
          })
          .catch((e: unknown) => host.note(`the telegram extension: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (item.name === "test") {
        if (t.chat === undefined) return;
        void new Telegram(t.token, host.apiBase)
          .sendMessage(t.chat, `🍄 a test from kinoko on ${hostname()}`, AbortSignal.timeout(10_000))
          .then(() => host.note("Telegram: test message sent"))
          .catch((e: unknown) => host.note(`Telegram: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (item.name !== "on" && item.name !== "notify" && item.name !== "prompts" && item.name !== "approvals") return;
      const key = item.name;
      void setTelegram(host.home, (cur) => (cur ? { ...cur, [key]: !cur[key] } : cur)).then((next) => {
        if (next) host.swap(page, optionsPage(host, next, hub, files));
      });
    },
    remove: () => {
      void setTelegram(host.home, () => undefined).then(() => {
        host.note("Telegram: disconnected, the token is forgotten");
        openIntegrations(host);
      });
    },
  };
  return page;
}
