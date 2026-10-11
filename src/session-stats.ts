// What sessions cost and did: per session and for a whole directory. Read from the session files
// (nothing else is recorded): tokens from each reply's usage, tools from the calls and their results.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "./session.ts";
import type { Message } from "./types.ts";

export interface ToolStat {
  name: string;
  calls: number;
  /** The tool said ERROR: bad arguments, a missing file, a refusal. */
  errors: number;
  /** It ran, but the command failed (bash's non-zero exit). */
  failed: number;
}

export interface SessionSummary {
  path: string;
  id: string;
  created: number;
  /** The file's last write: the last thing that happened in it. */
  updated: number;
  models: string[];
  /** The first thing the user asked (what the session is about). */
  first: string;
  messages: number;
  prompts: number;
  replies: number;
  sent: number;
  generated: number;
  cached: number;
  compactions: number;
  tools: ToolStat[];
}

/** kinoko's own notes to the model (a job ended, a skill installed) are not the user's prompts. */
const isPrompt = (m: Message): boolean => m.role === "user" && !m.content.startsWith("[kinoko]");

/** Each tool's calls, and how they went: their results are matched by call id. */
export function toolStats(messages: readonly Message[]): ToolStat[] {
  const results = new Map(messages.filter((m) => m.role === "tool" && m.toolCallId).map((m) => [m.toolCallId, m.content]));
  const by = new Map<string, ToolStat>();
  for (const call of messages.flatMap((m) => m.toolCalls ?? [])) {
    const stat = by.get(call.name) ?? { name: call.name, calls: 0, errors: 0, failed: 0 };
    stat.calls++;
    const result = results.get(call.id) ?? "";
    if (result.startsWith("ERROR")) stat.errors++;
    else if (/(^|\n)\[exit code -?\d+\]$/.test(result.trimEnd())) stat.failed++;
    by.set(call.name, stat);
  }
  return [...by.values()].toSorted((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function summarize(session: Session, updated: number): SessionSummary {
  const all = session.history;
  const sum = (pick: (m: Message) => number | undefined): number => all.reduce((n, m) => n + (pick(m) ?? 0), 0);
  const models = [session.meta.model, ...(session.model ? [session.model.model] : [])];
  return {
    path: session.path,
    id: session.meta.id,
    created: session.meta.created,
    updated,
    models: [...new Set(models.map((m) => (m.split("/").at(-1) ?? m).replace(/\.gguf$/i, "")))],
    first: all.find(isPrompt)?.content.replace(/\s+/g, " ").trim() ?? "",
    messages: all.length,
    prompts: all.filter(isPrompt).length,
    replies: all.filter((m) => m.role === "assistant").length,
    sent: sum((m) => m.usage?.input),
    generated: sum((m) => m.usage?.output),
    cached: sum((m) => m.usage?.cacheRead),
    compactions: session.compactions,
    tools: toolStats(all),
  };
}

/** The sessions in `dir` (one project's, see sessionDir), the most recent first. Ones nothing was
 *  said in are left out. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"));
  const read = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const session = await Session.load(path).catch(() => undefined);
      return session && !session.empty ? summarize(session, Bun.file(path).lastModified) : undefined;
    }),
  );
  return read.filter((s) => s !== undefined).toSorted((a, b) => b.updated - a.updated);
}

/** All of them added up: one summary for the directory. */
export function totals(list: SessionSummary[]): Omit<SessionSummary, "path" | "id" | "first"> & { sessions: number } {
  const add = (pick: (s: SessionSummary) => number): number => list.reduce((n, s) => n + pick(s), 0);
  const tools = new Map<string, ToolStat>();
  for (const t of list.flatMap((s) => s.tools)) {
    const sum = tools.get(t.name) ?? { name: t.name, calls: 0, errors: 0, failed: 0 };
    tools.set(t.name, { name: t.name, calls: sum.calls + t.calls, errors: sum.errors + t.errors, failed: sum.failed + t.failed });
  }
  return {
    sessions: list.length,
    created: Math.min(...list.map((s) => s.created)),
    updated: Math.max(...list.map((s) => s.updated)),
    models: [...new Set(list.flatMap((s) => s.models))],
    messages: add((s) => s.messages),
    prompts: add((s) => s.prompts),
    replies: add((s) => s.replies),
    sent: add((s) => s.sent),
    generated: add((s) => s.generated),
    cached: add((s) => s.cached),
    compactions: add((s) => s.compactions),
    tools: [...tools.values()].toSorted((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
  };
}
