// Diff blocks, read like a code review: added and removed lines on a green or red row, the words
// that changed inside a changed line marked brighter, the code coloured in its file's language
// (from the +++ header), and the file and hunk headers set apart from the code.

import { highlightLine, SYNTAX } from "./highlight.ts";
import type { HighlightState } from "./highlight.ts";
import { cells } from "./style.ts";

const ESC = "\x1b[";
const bg = (r: number, g: number, b: number): string => `${ESC}48;2;${r};${g};${b}m`;
const FG_OFF = `${ESC}39m`;
const BOLD = `${ESC}1m`;
const BOLD_OFF = `${ESC}22m`;
export const ADDED_BG = bg(34, 62, 46);
export const REMOVED_BG = bg(70, 36, 44);
const ADDED_WORD = bg(46, 102, 64);
const REMOVED_WORD = bg(122, 46, 58);

/** One line of the diff, coloured, and the background its row takes (none: the panel's). */
export interface DiffLine {
  text: string;
  bg?: string;
}

/** A diff fence, or an unlabelled fence whose text is plainly a diff. */
export function isDiff(lang: string, lines: string[]): boolean {
  const name = lang.toLowerCase();
  if (name === "diff" || name === "patch") return true;
  if (name !== "") return false;
  const first = lines.findIndex((line) => line.trim() !== "");
  const head = lines[first] ?? "";
  return head.startsWith("diff --git ") || head.startsWith("@@ ") || (head.startsWith("--- ") && (lines[first + 1] ?? "").startsWith("+++ "));
}

const paint = (color: string, text: string): string => (text === "" ? "" : `${color}${text}${FG_OFF}`);

/** What changed between a removed line and the added line that replaced it: [start, end) in
 *  each, or undefined when the two have too little in common for marks to help. */
function changed(old: string, now: string): { old: [number, number]; now: [number, number] } | undefined {
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let tail = 0;
  while (tail < old.length - start && tail < now.length - start && old[old.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  if (start + tail < Math.min(old.length, now.length) * 0.3) return undefined;
  return { old: [start, old.length - tail], now: [start, now.length - tail] };
}

/** `text` (with colours) with the visible characters in [from, to) on `mark`, then back to `base`. */
function mark(text: string, [from, to]: [number, number], on: string, base: string): string {
  if (from >= to) return text;
  let out = "";
  let at = 0;
  for (const cell of cells(text)) {
    if (cell.seq) {
      out += cell.text;
      continue;
    }
    if (at === from) out += on;
    out += cell.text;
    at += cell.text.length;
    if (at === to) out += base;
  }
  return out;
}

/** The file's language, from a `+++ b/src/x.ts` (or `--- a/...`) header. */
function language(path: string): string {
  return /\.([\w+-]+)$/.exec(path.trim().replace(/\t.*$/, ""))?.[1]?.toLowerCase() ?? "";
}

export function diffLines(lines: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let lang = "";
  let state: HighlightState = {};
  const code = (body: string, fallback: string): string => {
    if (lang === "") return paint(fallback, body);
    const lit = highlightLine(body, lang, state);
    state = lit.state;
    return lit.text;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      const next = lines[i + 1] ?? "";
      lang = language(next.slice(4).includes("/dev/null") ? line.slice(4) : next.slice(4)) || lang;
      out.push({ text: `${BOLD}${paint(SYNTAX.type, line)}${BOLD_OFF}` }, { text: `${BOLD}${paint(SYNTAX.type, next)}${BOLD_OFF}` });
      i++;
      continue;
    }
    if (/^(diff --git|index |new file|deleted file|similarity|rename |old mode|new mode|\\ )/.test(line)) {
      out.push({ text: paint(SYNTAX.comment, line) });
      continue;
    }
    const hunk = /^(@@[^@]*@@)(.*)$/.exec(line);
    if (hunk) {
      out.push({ text: `${paint(SYNTAX.fn, hunk[1] ?? "")}${paint(SYNTAX.comment, hunk[2] ?? "")}` });
      continue;
    }
    if (!line.startsWith("-") && !line.startsWith("+")) {
      out.push({ text: code(line, SYNTAX.plain) });
      continue;
    }
    // A run of removed lines then a run of added ones: the n-th of each are paired, and the part
    // of the pair that differs is marked.
    let end = i;
    while (end < lines.length && (lines[end] ?? "").startsWith("-") && !(lines[end] ?? "").startsWith("--- ")) end++;
    let plus = end;
    while (plus < lines.length && (lines[plus] ?? "").startsWith("+") && !(lines[plus] ?? "").startsWith("+++ ")) plus++;
    const removed = lines.slice(i, end).map((l) => l.slice(1));
    const added = lines.slice(end, plus).map((l) => l.slice(1));
    if (removed.length + added.length === 0) {
      out.push({ text: code(line, SYNTAX.plain) }); // a lone "--- x" with no +++ after it
      continue;
    }
    const pairs = removed.map((old, n) => (added[n] === undefined || removed.length !== added.length ? undefined : changed(old, added[n] ?? "")));
    removed.forEach((old, n) => {
      const span = pairs[n]?.old;
      const body = code(old, SYNTAX.removed);
      out.push({ text: `${paint(SYNTAX.removed, "-")}${span ? mark(body, span, REMOVED_WORD, REMOVED_BG) : body}`, bg: REMOVED_BG });
    });
    added.forEach((now, n) => {
      const span = pairs[n]?.now;
      const body = code(now, SYNTAX.added);
      out.push({ text: `${paint(SYNTAX.added, "+")}${span ? mark(body, span, ADDED_WORD, ADDED_BG) : body}`, bg: ADDED_BG });
    });
    i = plus - 1;
  }
  return out;
}
