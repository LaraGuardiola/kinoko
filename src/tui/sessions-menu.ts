// /sessions: this directory's sessions, what each cost (tokens) and did (tools, and how they went),
// one session's numbers, then per tool; the first row adds them all up.

import { listSessions, totals } from "../session-stats.ts";
import type { SessionSummary, ToolStat } from "../session-stats.ts";
import type { InfoPage, ListPage, MenuPage } from "./menu.ts";
import { renderTable } from "./table.ts";

export interface SessionsHost {
  /** This directory's sessions folder (sessionDir). */
  dir: string;
  /** The session this TUI is in: marked in the list, and its context shown live. */
  current?: { id: string; context: number; window: number };
  width: () => number;
  /** R on a past session: this TUI goes on with it. */
  resume?: (path: string) => void;
  open: (page: MenuPage) => void;
  swap: (from: MenuPage, to: MenuPage) => void;
}

const num = (n: number): string => n.toLocaleString("en-US");
/** 45.2k, 1.3M: short enough for a list row. */
const short = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const when = (ms: number): string => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const cell = (text: string): string => text.replaceAll("|", "\\|");
const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

function table(head: string, rows: Array<[string, string]>, width: number): string[] {
  return renderTable([`| ${head} | |`, "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`)], width, (text) => text);
}

/** "bash 12 (2 failed) · read 5 (1 error) · music 3" */
export function toolsLine(tools: ToolStat[]): string {
  if (tools.length === 0) return "none";
  return tools
    .map((t) => {
      const bad = [t.errors ? `${t.errors} error${t.errors === 1 ? "" : "s"}` : "", t.failed ? `${t.failed} failed` : ""].filter(Boolean).join(", ");
      return `${t.name} ${t.calls}${bad ? ` (${bad})` : ""}`;
    })
    .join(" · ");
}

/** One row per tool: how often, and how it went. */
export function toolsTable(tools: ToolStat[], width: number): string[] {
  if (tools.length === 0) return ["  no tools were called"];
  const rows = tools.map((t) => `| ${cell(t.name)} | ${num(t.calls)} | ${num(t.calls - t.errors - t.failed)} | ${num(t.errors)} | ${num(t.failed)} | ${percent(t.calls - t.errors - t.failed, t.calls)} |`);
  return renderTable(["| Tool | Calls | OK | Errors | Failed | Success |", "|---|--:|--:|--:|--:|--:|", ...rows], width, (text) => text);
}

type Numbers = Omit<SessionSummary, "path" | "id" | "first">;

/** The rows every summary has, one session's or the directory's. */
function costRows(s: Numbers): Array<[string, string]> {
  const calls = s.tools.reduce((n, t) => n + t.calls, 0);
  const bad = s.tools.reduce((n, t) => n + t.errors + t.failed, 0);
  return [
    ["Model", s.models.join(", ") || "–"],
    ["Messages", `${num(s.messages)} (${num(s.prompts)} prompts, ${num(s.replies)} replies)`],
    ["Tokens", `${num(s.sent)} sent, ${num(s.generated)} generated`],
    ["Cached", s.sent > 0 ? `${percent(s.cached, s.sent)} (${num(s.cached)} of ${num(s.sent)} sent)` : "nothing sent yet"],
    ["Per reply", s.replies > 0 ? `${num(Math.round(s.sent / s.replies))} sent, ${num(Math.round(s.generated / s.replies))} generated` : "–"],
    ["Compactions", num(s.compactions)],
    ["Tools", `${num(calls)} calls, ${percent(calls - bad, calls)} went well`],
    ["Used", toolsLine(s.tools)],
  ];
}

function sessionPage(host: SessionsHost, s: SessionSummary): InfoPage {
  const live = host.current?.id === s.id ? host.current : undefined;
  const rows: Array<[string, string]> = [
    ["File", s.path],
    ["ID", s.id],
    ["Started", new Date(s.created).toLocaleString("en-GB")],
    ["Last", new Date(s.updated).toLocaleString("en-GB")],
    ["First", s.first || "–"],
    ...(live ? [["Context", `${num(live.context)} / ${num(live.window)} (${percent(live.context, live.window)})`] as [string, string]] : []),
    ...costRows(s),
    ...(live ? [] : [["Resume", `R here, or kinoko --session ${s.id}`] as [string, string]]),
  ];
  const resume = live ? undefined : host.resume;
  return {
    kind: "info",
    title: live ? "Session · this one" : `Session · ${when(s.created)}`,
    lines: table("Session", rows, host.width()),
    hint: `Enter: per tool${resume ? " · R resumes it here" : ""} · Esc to go back`,
    ...(resume ? { keys: { r: () => resume(s.path) } } : {}),
    next: () => host.open({ kind: "info", title: `Tools · ${when(s.created)}`, lines: toolsTable(s.tools, host.width()) }),
  };
}

function allPage(host: SessionsHost, list: SessionSummary[]): InfoPage {
  const sum = totals(list);
  const rows: Array<[string, string]> = [["Sessions", `${num(sum.sessions)}, ${when(sum.created)} to ${when(sum.updated)}`], ...costRows(sum)];
  return {
    kind: "info",
    title: "Sessions · all here",
    lines: table("All sessions here", rows, host.width()),
    hint: "Enter: per tool · Esc to go back",
    next: () => host.open({ kind: "info", title: "Tools · all sessions here", lines: toolsTable(sum.tools, host.width()) }),
  };
}

const firstPrompt = (s: SessionSummary): string => (s.first.length > 48 ? `${s.first.slice(0, 47)}…` : s.first || "(no prompt)");

/** The list: all of them first, then each session, the latest first. */
export function sessionsPage(host: SessionsHost, list: SessionSummary[]): ListPage {
  const all = totals(list);
  return {
    kind: "list",
    title: "Sessions",
    items: [
      ...(list.length > 0 ? [{ name: "all", key: "all", description: `${num(list.length)} sessions · ${short(all.sent + all.generated)} tokens · ${num(all.tools.reduce((n, t) => n + t.calls, 0))} tool calls` }] : []),
      ...list.map((s) => ({ name: when(s.updated), key: s.id, current: s.id === host.current?.id, description: `${firstPrompt(s)} · ${s.prompts} prompt${s.prompts === 1 ? "" : "s"} · ${short(s.sent + s.generated)} tok` })),
    ],
    empty: "nothing said in this directory yet",
    hint: "Enter: its numbers · the first row adds them all up",
    pick: (item) => {
      const s = list.find((x) => x.id === item.key);
      host.open(item.key === "all" ? allPage(host, list) : s ? sessionPage(host, s) : allPage(host, list));
    },
  };
}

/** Opens the list; the files are read in the background (a long history takes a moment). */
export function openSessions(host: SessionsHost): void {
  const loading: ListPage = { kind: "list", title: "Sessions", items: [], empty: "reading this directory's sessions…", pick: () => undefined };
  host.open(loading);
  void listSessions(host.dir)
    .catch(() => [] as SessionSummary[])
    .then((list) => host.swap(loading, sessionsPage(host, list)));
}
