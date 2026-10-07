import { resolve } from "node:path";
import { tracker, checkRead, stateOf } from "./tracker";
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

function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], idx: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function lineText(text: string, starts: number[], n: number): string {
  const from = starts[n] ?? text.length;
  const hi = n + 1 < starts.length ? (starts[n + 1] ?? text.length) - 1 : text.length;
  return text.slice(from, hi).trimEnd();
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

function overlapScore(needle: string, line: string): number {
  const target = bigrams(needle);
  let count = 0;
  for (const g of bigrams(line)) {
    if (target.has(g)) count++;
  }
  return count;
}

function hintLines(content: string, old: string, starts: number[]): string {
  const nold = normalize(old).s;
  const scored: { n: number; score: number }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const score = overlapScore(nold, lineText(content, starts, i));
    if (score > 0) scored.push({ n: i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  return top.map((s) => `${s.n + 1}: ${lineText(content, starts, s.n).slice(0, 120)}`).join("\n");
}

function fileIsBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

async function editRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  if (typeof path !== "string") return "ERROR: edit: path must be a string";
  const abs = resolve(ctx.cwd, path);
  const file = Bun.file(abs);
  if (!await file.exists()) return `ERROR: edit: file not found: ${path}`;
  const content = await file.text();
  if (fileIsBinary(content)) return `ERROR: edit refused: ${path} looks binary`;
  const err = checkRead(abs);
  if (err) return err;

  const rawEdits = args.edits;
  if (!Array.isArray(rawEdits)) return "ERROR: edit: edits must be an array of { old, new }";
  const norm = normalize(content);
  const starts = lineStarts(content);
  const ranges: Range[] = [];
  for (const raw of rawEdits) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "ERROR: edit: each edit must be an object";
    const e = raw as Record<string, unknown>;
    const old = e.old;
    const repl = e.new;
    if (typeof old !== "string" || typeof repl !== "string") return "ERROR: edit: old and new must be strings";
    const nold = normalize(old).s;
    if (!nold) return "ERROR: edit: old must not be empty";
    const hits = findAll(norm.s, nold);
    if (hits.length === 0) {
      return `ERROR: edit: not found — "${old}" not found in ${path}. Closest lines:\n${hintLines(content, old, starts)}`;
    }
    if (hits.length > 1) {
      const hints: string[] = [];
      for (let k = 0; k < Math.min(3, hits.length); k++) {
        const h = hits[k] ?? 0;
        const orig = norm.map[h] ?? 0;
        const line = lineAt(starts, orig);
        hints.push(`${line + 1}: ${lineText(content, starts, line)}`);
      }
      return `ERROR: edit: ambiguous — old text matches ${hits.length} times in ${path}; add more context. Closest lines:\n${hints.join("\n")}`;
    }
    const hit = hits[0];
    if (hit === undefined) continue;
    const start = norm.map[hit] ?? 0;
    const end = (norm.map[hit + nold.length - 1] ?? content.length) + 1;
    ranges.push({ start, end, repl });
  }

  ranges.sort((a, b) => a.start - b.start);
  let prev: Range | null = null;
  for (const cur of ranges) {
    if (prev !== null && prev.start < prev.end) return "ERROR: edit: edits overlap — merge them into one edit";
    prev = cur;
  }

  let out = content;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const r = ranges[k];
    if (r === undefined) continue;
    out = out.slice(0, r.start) + r.repl + out.slice(r.end);
  }
  await Bun.write(abs, out);
  const rec = stateOf(abs, out);
  if (rec) tracker.record(abs, rec);
  return `edited ${path}: ${ranges.length} edit(s) applied`;
}

export const editTool: Tool = {
  name: "edit",
  description: "Apply exact substring edits [{old,new}] to a file. Each old must match exactly once (not-found and ambiguous errors are reported with hints); overlapping edits are rejected; all edits apply or none. The file must have been read and be unchanged since.",
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
