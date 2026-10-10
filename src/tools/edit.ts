import { resolve } from "node:path";
import { checkRead, remember } from "./tracker";
import type { Tool, ToolContext } from "../types";

interface Range {
  start: number;
  end: number;
  repl: string;
}

interface Norm {
  s: string;
  map: number[];
}

const SMART: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
};

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r";
}

function normChar(ch: string): string {
  const mapped = SMART[ch] ?? ch;
  return mapped.normalize("NFKC");
}

/** Normalize for matching: smart quotes, per-char NFKC, trailing line whitespace dropped.
 * map[i] = index in the ORIGINAL string of the char that produced normalized char i. */
function normalize(text: string): Norm {
  const chars: string[] = [];
  const map: number[] = [];
  let lineEnd = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\n") {
      chars.length = lineEnd;
      map.length = lineEnd;
      chars.push("\n");
      map.push(i);
      lineEnd = chars.length;
      continue;
    }
    const mapped = normChar(ch);
    for (const nc of mapped) {
      chars.push(nc);
      map.push(i);
      if (!isWs(nc)) lineEnd = chars.length;
    }
  }
  chars.length = lineEnd;
  map.length = lineEnd;
  return { s: chars.join(""), map };
}

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = hay.indexOf(needle, idx + 1);
  }
  return out;
}

/** 1-based line of a char index. */
function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < idx; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** How many of `line`'s character pairs also appear in `target`. */
function overlap(target: Set<string>, line: string): number {
  let count = 0;
  for (let i = 0; i + 1 < line.length; i++) if (target.has(line.slice(i, i + 2))) count++;
  return count;
}

/**
 * The file text most like `old`, as a window of its size, so the model can copy the real lines
 * instead of guessing again. Each line of `old` votes for where the window starts.
 */
function closest(content: string, old: string): string {
  const lines = content.split("\n");
  const want = old.split("\n").slice(0, 20);
  let best = { score: 0, at: 0 };
  for (const [i, w] of want.entries()) {
    const t = w.trim();
    const target = new Set<string>();
    for (let k = 0; k + 1 < t.length; k++) target.add(t.slice(k, k + 2));
    if (target.size < 3) continue; // "}" or a blank line anchors nothing
    for (const [n, line] of lines.entries()) {
      const score = overlap(target, line);
      if (score > best.score) best = { score, at: n - i };
    }
  }
  if (best.score === 0) return "Nothing similar in the file: read it again.";
  const from = Math.max(0, best.at);
  const to = Math.min(lines.length, from + want.length);
  const rows = lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`);
  return `Closest text (lines ${from + 1}-${to}):\n${rows.join("\n")}`;
}

/** Lines of context around an edit in its result, and the most shown per edit. */
const CONTEXT = 2;
const MAX_SHOWN = 30;

function fileIsBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

async function editRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  if (typeof path !== "string") return "ERROR: edit: missing path (string)";
  const abs = resolve(ctx.cwd, path);
  const file = Bun.file(abs);
  if (!await file.exists()) return `ERROR: edit: file not found: ${path}`;
  const content = await file.text();
  if (fileIsBinary(content)) return `ERROR: edit refused: ${path} looks binary`;
  const err = await checkRead(abs, content);
  if (err) return err;

  const rawEdits = args.edits;
  if (!Array.isArray(rawEdits)) return "ERROR: edit: edits must be an array of { old, new }";
  let norm: Norm | undefined; // built only when an old string does not match byte for byte
  const ranges: Range[] = [];
  for (const raw of rawEdits) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "ERROR: edit: each edit must be an object";
    const e = raw as Record<string, unknown>;
    const old = e.old;
    const repl = e.new;
    if (typeof old !== "string" || typeof repl !== "string") return "ERROR: edit: old and new must be strings";
    if (!old) return "ERROR: edit: old must not be empty";
    let hits = findAll(content, old);
    let rangeAt = (h: number): Range => ({ start: h, end: h + old.length, repl });
    if (hits.length === 0) {
      // Fallback: forgive smart quotes, NFKC variants and trailing whitespace.
      const n = (norm ??= normalize(content));
      const nold = normalize(old).s;
      hits = nold ? findAll(n.s, nold) : [];
      rangeAt = (h) => ({ start: n.map[h] ?? 0, end: (n.map[h + nold.length - 1] ?? content.length) + 1, repl });
    }
    if (hits.length === 0) return `ERROR: edit: old text not found in ${path}. ${closest(content, old)}`;
    if (hits.length > 1) {
      const at = hits.slice(0, 3).map((h) => lineOf(content, rangeAt(h).start));
      return `ERROR: edit: ambiguous — old text matches ${hits.length} times in ${path} (lines ${at.join(", ")}…); add more context`;
    }
    ranges.push(rangeAt(hits[0]!));
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k]!.start < ranges[k - 1]!.end) return "ERROR: edit: edits overlap — merge them into one edit";
  }

  let out = content;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k];
    if (r === undefined) continue;
    out = out.slice(0, r.start) + r.repl + out.slice(r.end);
  }
  await Bun.write(abs, out);
  await remember(abs, out);
  return `edited ${path}: ${ranges.length} edit(s) applied. The file now reads:\n${changed(out, ranges)}`;
}

/** Lines around each edit as they are now on disk: the result, not the model's memory of it. */
function changed(out: string, ranges: Range[]): string {
  const lines = out.split("\n");
  const rows: string[] = [];
  let shift = 0;
  let shown = 0; // last line already printed (1-based)
  for (const r of ranges) {
    const start = r.start + shift;
    shift += r.repl.length - (r.end - r.start);
    const from = Math.max(shown + 1, lineOf(out, start) - CONTEXT);
    const to = Math.min(lines.length, lineOf(out, start + r.repl.length) + CONTEXT, from + MAX_SHOWN - 1);
    if (from > shown + 1 && shown > 0) rows.push("…");
    for (let n = from; n <= to; n++) rows.push(`${n}: ${lines[n - 1]}`);
    shown = Math.max(shown, to);
  }
  return rows.join("\n");
}

export const editTool: Tool = {
  name: "edit",
  description: "Apply exact substring edits [{old,new}] to a file. Each old must match exactly once (not-found and ambiguous errors are reported with hints); overlapping edits are rejected; all edits apply or none. Several changes to one file: one call with several edits. The file must have been read and be unchanged since.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old: { type: "string" },
            new: { type: "string" },
          },
          required: ["old", "new"],
        },
      },
    },
    required: ["path", "edits"],
  },
  run: editRun,
};
