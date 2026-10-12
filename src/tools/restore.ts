// Read-before-change across a restart. The tracker lives in memory, so a resumed session would
// otherwise demand a fresh read of every file the model wrote or read a minute ago, while its own
// history says it knows them. This rebuilds, from that history, the last content the model saw of
// each file, and trusts a file only when the disk still holds exactly that: anything else changed
// it since, and a read is still required.

import { resolve } from "node:path";
import type { Message } from "../types.ts";
import { hashOf, tracker } from "./tracker.ts";

/** A read's output back to the file's text: "  12: text" rows; a labelled (partial) read is not whole. */
function readText(output: string): string | undefined {
  if (output.startsWith("ERROR") || output.startsWith("read:")) return undefined;
  const rows = output.split("\n");
  if (/^\[lines \d+-\d+ of \d+/.test(rows.at(-1) ?? "")) return undefined;
  const text: string[] = [];
  for (const row of rows) {
    const m = /^ *\d+: ?(.*)$/s.exec(row);
    if (!m) return undefined;
    text.push(m[1] ?? "");
  }
  return text.join("\n");
}

/** Replays one edit call on known content; undefined when an old string is not there byte for byte. */
function applyEdits(content: string, edits: unknown): string | undefined {
  if (!Array.isArray(edits)) return undefined;
  let out = content;
  for (const e of edits as Array<{ old?: unknown; new?: unknown }>) {
    if (typeof e.old !== "string" || typeof e.new !== "string") return undefined;
    const at = out.indexOf(e.old);
    if (at < 0) return undefined;
    out = out.slice(0, at) + e.new + out.slice(at + e.old.length);
  }
  return out;
}

/** The trailing newline is not visible in a read, so it never decides a match. */
const body = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** Marks as read every file whose last content in `messages` is still exactly what is on disk. */
export async function restoreTracker(messages: Message[], cwd: string): Promise<number> {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m.content);
  const known = new Map<string, string | undefined>(); // abs path -> last content seen (undefined: unknown)
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      const args = (call.args ?? {}) as { path?: unknown; content?: unknown; edits?: unknown };
      const out = results.get(call.id) ?? "";
      if (typeof args.path !== "string") continue;
      const path = resolve(cwd, args.path);
      if (call.name === "write" && out.startsWith("wrote") && typeof args.content === "string") known.set(path, args.content);
      else if (call.name === "read") known.set(path, readText(out) ?? known.get(path));
      else if (call.name === "edit" && out.startsWith("edited")) {
        const before = known.get(path);
        known.set(path, before === undefined ? undefined : applyEdits(before, args.edits));
      }
    }
  }
  let restored = 0;
  for (const [path, content] of known) {
    if (content === undefined) continue;
    const file = Bun.file(path);
    // oxlint-disable-next-line no-await-in-loop -- a handful of small files, once, at resume
    const disk = await file.text().catch(() => undefined);
    if (disk === undefined || body(disk) !== body(content)) continue;
    // oxlint-disable-next-line no-await-in-loop -- same pass
    const st = await file.stat();
    tracker.record(path, { mtimeMs: st.mtimeMs, hash: hashOf(disk) });
    restored++;
  }
  return restored;
}
