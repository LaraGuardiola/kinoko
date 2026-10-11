// What the Telegram bridge writes: replies as Telegram's HTML (code in <pre>, the rest escaped),
// run endings, the agents list, approvals. Pure functions, so they are tested on their own.

import type { ApprovalBy } from "../approvals.ts";
import type { AgentInfo } from "./agents.ts";
import { capMessage, escapeHtml } from "./telegram.ts";

/** Markdown as Telegram's HTML: fenced code in <pre>, `inline` in <code>, **bold** in <b>. */
export function toHtml(markdown: string): string {
  const parts = markdown.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${escapeHtml(part.replace(/\n$/, ""))}</pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    })
    .join("")
    .trim();
}

/** "45s", "2m 10s", "1h 5m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A run that ended: how, how long, then the reply (cut to fit a message). */
export function endedText(info: AgentInfo, reason: string, ms: number, reply: string, detail?: string): string {
  const how = reason === "error" ? `failed${detail ? `: ${detail}` : ""}` : reason === "limit" ? `stopped at a limit${detail ? `: ${detail}` : ""}` : "done";
  const head = `🍄 <b>${escapeHtml(info.project)}</b> · ${escapeHtml(how)} in ${duration(ms)}`;
  return capMessage(reply.trim() === "" ? head : `${head}\n\n${toHtml(reply)}`);
}

/** The agents, one line each, the selected one marked. */
export function agentsText(list: AgentInfo[], selected: string | undefined): string {
  if (list.length === 0) return "No agents running. /new starts one.";
  return list
    .map((a) => `${a.id === selected ? "▶" : "·"} <b>${escapeHtml(a.project)}</b> ${stateWord(a)}${a.title ? ` · ${escapeHtml(a.title)}` : ""}`)
    .join("\n");
}

export function stateWord(a: AgentInfo): string {
  if (a.approval) return "waiting for you";
  if (a.state === "running") return "working";
  if (a.state === "exited") return "exited";
  return a.origin === "terminal" ? "idle (terminal)" : "idle";
}

/** What an approval asks: the command in <pre>, and why. */
export function approvalText(project: string, call: { name: string; args: Record<string, unknown> }, reason: string): string {
  const command = call.args.command ?? call.args.cmd;
  const what = call.name === "bash" && typeof command === "string" ? command : `${call.name} ${JSON.stringify(call.args)}`;
  return capMessage(`🔐 <b>${escapeHtml(project)}</b> wants to run:\n<pre>${escapeHtml(what.slice(0, 3000))}</pre>\n${escapeHtml(reason)}`);
}

/** The approval's message once answered, by whoever answered. */
export function answeredText(asked: string, allow: boolean, by: ApprovalBy): string {
  const where = by === "tui" ? "from the terminal" : by === "app" ? "from the phone app" : by === "telegram" ? "here" : "";
  const outcome = by === "timeout" ? "⌛ nobody answered: denied" : by === "abort" ? "⏹ the run was stopped" : `${allow ? "✅ allowed" : "❌ denied"} ${where}`;
  return `${asked}\n\n${outcome}`;
}

export const HELP = [
  "Write to talk to the selected agent (a reply to one of my messages goes to that agent).",
  "Send a file or a photo (with a caption): it is saved on the computer and the agent is told where.",
  "/agents · pick an agent",
  "/new · start an agent in a project",
  "/status · what the selected agent is doing",
  "/stop · stop its run",
  "/compact · summarize its history",
  "/models · switch its model",
].join("\n");
