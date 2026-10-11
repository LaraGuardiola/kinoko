// What the slash menu offers: the root's commands, the thinking profiles, and the session table.

import type { Entry } from "../catalog.ts";
import type { ProviderRequest, Message } from "../types.ts";
import type { ListPage, MenuItem } from "./menu.ts";
import { languageName } from "./code.ts";
import type { Snippet } from "./snippets.ts";
import { renderTable } from "./table.ts";

export const ROOT: MenuItem[] = [
  { name: "thinking", description: "How much the model thinks: off, low, medium, high, extreme" },
  { name: "models", description: "Pick the model for the next requests" },
  { name: "extensions", description: "Install, switch on or off, update or remove extensions" },
  { name: "skills", description: "Install, switch on or off, update or remove skills" },
  { name: "session", description: "This session: file, id, messages, tokens" },
  { name: "integrations", description: "Telegram (and more later): notifications, prompts, approvals" },
  { name: "copy", description: "Copy a code block from the replies (or click its ⧉)" },
  { name: "new", description: "Start a new session: empty context, same model" },
  { name: "clear", description: "Clear the screen (the context stays)" },
  { name: "compact", description: "Summarize the history now" },
  { name: "fork", description: "Move the session head back one message" },
  { name: "help", description: "Keys and commands" },
  { name: "quit", description: "Quit kinoko" },
];

export interface ThinkingProfile {
  name: string;
  effort: ProviderRequest["effort"];
  /** Token cap on the thinking; 0 is no cap. Sent only where the engine takes a budget. */
  budget: number;
  description: string;
}

export const THINKING: ThinkingProfile[] = [
  { name: "off", effort: "off", budget: 0, description: "No thinking: answers at once" },
  { name: "low", effort: "low", budget: 2048, description: "Brief: at most 2,048 tokens" },
  { name: "medium", effort: "medium", budget: 4096, description: "At most 4,096 tokens" },
  { name: "high", effort: "high", budget: 8192, description: "At most 8,192 tokens" },
  { name: "extreme", effort: "high", budget: 0, description: "Thinks as long as it wants (no cap)" },
];

/** The rule label for a profile: "LOW · 1024", or just the name when there is no cap to show. */
export function profileLabel(profile: ThinkingProfile, budgets: boolean): string {
  const name = profile.name.toUpperCase();
  return budgets && profile.budget > 0 && profile.effort !== "off" ? `${name} · ${profile.budget}` : name;
}

/** The thinking page: one item per profile, the one in effect marked. */
export function thinkingPage(current: string | undefined, choose: (profile: ThinkingProfile) => void): ListPage {
  return {
    kind: "list",
    title: "Thinking",
    items: THINKING.map((p) => ({ name: p.name, description: p.description, current: p.name === current })),
    empty: "",
    pick: (item) => {
      const profile = THINKING.find((p) => p.name === item.name);
      if (profile) choose(profile);
    },
  };
}

/** The copy page: the replies' code blocks, newest first; Enter or a click copies one. */
export function copyPage(list: Snippet[], copy: (snippet: Snippet) => void): ListPage {
  return {
    kind: "list",
    title: "Copy",
    items: list.map((s, i) => {
      const lines = s.code.split("\n");
      const first = (lines.find((l) => l.trim() !== "") ?? "").trim();
      const preview = first.length > 48 ? `${first.slice(0, 47)}…` : first;
      return { name: languageName(s.lang) || "Text", key: String(i), description: `${preview}  · ${lines.length} line${lines.length === 1 ? "" : "s"}` };
    }),
    empty: "no code blocks in the replies yet",
    pick: (item) => {
      const snippet = list[Number(item.key)];
      if (snippet) copy(snippet);
    },
  };
}

/** A catalog's page (extensions, skills): the repository's entries; the installed ones switched on
 *  (●) or off (○) with Enter, updated with U, removed with Del twice. */
export function catalogPage(
  title: string,
  state: { repo: string; entries?: Entry[]; error?: string },
  actions: { install: (name: string) => void; toggle: (name: string, on: boolean) => void; update: (name: string) => void; remove: (name: string) => void },
): ListPage {
  const where = state.repo.replace(/^https?:\/\/|^git@|\.git$/g, "").replace(":", "/");
  return {
    kind: "list",
    title,
    items: (state.entries ?? []).map((e) => ({
      name: e.name,
      key: e.name,
      description: `${e.installed && !e.enabled ? "off · " : ""}${e.shared ? "shared · " : ""}${e.description}`,
      current: e.installed && e.enabled !== false,
      off: e.installed && e.enabled === false,
      removable: e.installed && !e.shared,
    })),
    empty: state.error ?? (state.entries === undefined ? `fetching ${where}…` : `nothing in ${where}`),
    pick: (item) => {
      const entry = state.entries?.find((e) => e.name === item.name);
      if (entry?.installed) actions.toggle(item.name, entry.enabled === false);
      else actions.install(item.name);
    },
    update: (item) => {
      const entry = state.entries?.find((e) => e.name === item.name);
      if (entry && !entry.shared) actions.update(item.name);
    },
    remove: (item) => actions.remove(item.name),
    stay: true,
    // Offline, the list is the last fetched copy and what is installed: say so, and why.
    hint: state.error && state.entries?.length ? `${state.error} · showing what is on this computer` : "Enter installs, or switches on/off · U updates · Del twice removes · in effect at once",
  };
}

export interface SessionFacts {
  path: string;
  id: string;
  created: number;
  messages: Message[];
  context: number;
  window: number;
}

const num = (n: number): string => n.toLocaleString("en-US");
/** Cells are plain text: the table's own separator is escaped so a path can never split a row. */
const cell = (text: string): string => text.replaceAll("|", "\\|");

const KEYS: Array<[string, string]> = [
  ["Enter", "Send as prompt (idle) / steer (running)"],
  ["Alt+Enter", "Follow-up (running) / send (idle), kitty-protocol terminals"],
  ["Shift+Enter", "Newline in the input (also Ctrl-J)"],
  ["Esc", "Abort the run; in the menu, back a page, then close it"],
  ["Ctrl-C", "Abort / clear the input / quit on a second press"],
  ["Ctrl-D", "Quit when the input is empty"],
  ["Ctrl-T", "Expand or collapse tool output"],
  ["Ctrl-O", "Unfold the plan over the side column (↑↓ PgUp PgDn scroll, Esc folds); narrow: print it"],
  ["Ctrl-V", "Paste the clipboard image as [Image #N] (also drop an image file)"],
  ["Alt+Up", "Pull the last queued message back into the input"],
  ["Alt+X", "Send the waiting steer now: cuts the reply being written (thinking included)"],
  ["Alt+C", "Cancel the queued messages: they go back into the input"],
  ["Ctrl-P / Ctrl-N", "Previous / next history entry"],
  ["/", "Open the menu below; type to narrow it, arrows and Enter to choose"],
  ["@", "Reference a file: lists the directory as you type; arrows, Tab or Enter to complete"],
  ["Click ⧉", "Copy the code block (the mouse is kinoko's)"],
  ["Shift + wheel / drag", "The terminal's: scroll the history, select text"],
];

/** /help: one table for the keys, one for the menu (built from ROOT, so it cannot fall behind). */
export function helpText(width: number): string {
  const table = (head: string, rows: Array<[string, string]>): string[] =>
    renderTable([`| ${head} | |`, "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`)], width, (text) => text);
  const menu = ROOT.map((item): [string, string] => [`/${item.name}`, item.description]);
  return [...table("Keys", KEYS), "", ...table("Menu", menu)].join("\n");
}

/** The session page: one table of what this session is and what it has cost. */
export function sessionLines(facts: SessionFacts, width: number): string[] {
  const all = facts.messages;
  const user = all.filter((m) => m.role === "user" && !m.content.startsWith("[kinoko]")).length;
  const assistant = all.filter((m) => m.role === "assistant").length;
  const calls = all.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  const results = all.filter((m) => m.role === "tool").length;
  const sent = all.reduce((n, m) => n + (m.usage?.input ?? 0), 0);
  const generated = all.reduce((n, m) => n + (m.usage?.output ?? 0), 0);
  // How much of what was sent the engine read from its cache instead of processing it again.
  const cached = all.reduce((n, m) => n + (m.usage?.cacheRead ?? 0), 0);
  const hit = sent > 0 ? `${Math.round((cached / sent) * 100)}% (${num(cached)} of ${num(sent)} sent)` : "nothing sent yet";
  const full = facts.window > 0 ? ` (${Math.round((facts.context / facts.window) * 100)}%)` : "";
  const rows = [
    ["File", facts.path],
    ["ID", facts.id],
    ["Started", new Date(facts.created).toLocaleString("en-GB")],
    ["Messages", `${num(all.length)} (user ${num(user)}, assistant ${num(assistant)})`],
    ["Tools", `${num(calls)} calls, ${num(results)} results`],
    ["Context", `${num(facts.context)} / ${num(facts.window)}${full}`],
    ["Tokens", `${num(sent)} sent, ${num(generated)} generated`],
    ["Cached", hit],
  ];
  const source = ["| Session | |", "|---|---|", ...rows.map(([k, v]) => `| ${cell(k ?? "")} | ${cell(v ?? "")} |`)];
  return renderTable(source, width, (text) => text);
}
