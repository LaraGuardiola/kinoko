// A fenced code block drawn like an editor pane: a panel with its own background, the language's
// full name in the top-right corner and syntax colours. Long lines soft-wrap at token boundaries
// with a hanging indent, so the background never breaks. No line numbers: a terminal cannot make
// them unselectable, and a mouse copy should come out as the code (plus the two-column margin).

import { diffLines, isDiff } from "./diff.ts";
import { highlightLine } from "./highlight.ts";
import type { HighlightState } from "./highlight.ts";
import { cells, stripAnsi, visibleLength, wrapAnsi } from "./style.ts";
import { isTree, treeRows } from "./tree.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const PANEL = `${ESC}48;2;36;38;52m`;
const LABEL = `${ESC}3m${ESC}38;2;150;156;182m`;
/** The copy mark after the language: a click on it copies the block (the phone app's: a tap). */
export const COPY = "⧉";

/**
 * The blocks drawn lately, for a click on a mark: each one's code and the text of its first rows
 * under the label. The rows under a clicked mark are matched against them: nothing hidden is
 * written to the terminal, so the rows the phone gets and every width stay as they are.
 */
const copies = new Map<string, string[]>();
const KEPT_ROWS = 8;

function keep(code: string, rows: string[]): void {
  copies.delete(code);
  copies.set(code, rows.slice(2, 2 + KEPT_ROWS).map((r) => stripAnsi(r).trim()));
  if (copies.size > 200) copies.delete(copies.keys().next().value ?? "");
}

/** The code of the block whose first rows are `below` (the rows under a clicked mark), if one was drawn. */
export function copyFor(below: string[]): string | undefined {
  const shown = below.map((r) => stripAnsi(r).trim());
  let best: { code: string; rows: number } | undefined;
  for (const [code, rows] of copies) {
    const n = rows.findIndex((r, i) => r !== shown[i]);
    const matched = n === -1 ? rows.length : n;
    // The whole block's first rows, or as many as the screen shows; the latest drawn wins a tie.
    if ((n === -1 || matched === shown.length) && matched > 0 && matched >= (best?.rows ?? 0)) best = { code, rows: matched };
  }
  return best?.code;
}
const MARK = `${ESC}38;2;150;156;182m`;

export interface CodeOptions {
  lang: string;
  /** Columns the panel spans (the transcript width). */
  width: number;
  color?: boolean;
}

/** The panel's rows for a code block's lines (fences excluded). A diff gets its review colours
 *  (diff.ts), a directory tree its guides (tree.ts). */
export function codeBlock(lines: string[], opts: CodeOptions): string[] {
  const color = opts.color ?? true;
  const tree = isTree(lines) && /^(|text|txt|plain|plaintext|tree|sh|bash|shell|console)$/i.test(opts.lang);
  if (!color) return tree ? treeRows(lines, Math.max(4, opts.width - 2), false).map((line) => `  ${line}`) : lines.map((line) => `  ${line}`);
  const width = Math.max(12, opts.width);
  // A column of padding each side, and one more before the code: a two-column margin.
  const inner = width - 2;
  const codeWidth = Math.max(4, inner - 1);
  const diff = isDiff(opts.lang, lines);
  const rows: string[] = [row("", inner), row(label(diff ? "diff" : tree ? "tree" : opts.lang, inner), inner)];
  if (tree) {
    for (const line of treeRows(lines, codeWidth)) rows.push(row(` ${line}`, inner));
  } else if (diff) {
    for (const line of diffLines(lines)) {
      for (const piece of wrapCode(line.text, codeWidth, 2)) rows.push(row(` ${piece}`, inner, line.bg));
    }
  } else {
    let state: HighlightState = {};
    for (const line of lines) {
      const lit = highlightLine(line, opts.lang, state);
      state = lit.state;
      // A continuation row hangs two columns deeper than the line's own indentation, like an editor's
      // soft wrap, so it reads as the same line and not as the next one.
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      const pieces = wrapCode(lit.text, codeWidth, Math.min(indent + 2, Math.floor(codeWidth / 2)));
      for (const piece of pieces) rows.push(row(` ${piece}`, inner));
    }
  }
  rows.push(row("", inner));
  keep(lines.join("\n"), rows);
  return rows;
}

/** Rows an extension drew for the fence (a diagram), in the same panel, uncoloured by us. */
export function drawnBlock(drawn: string[], opts: { lang: string; width: number; code: string }): string[] {
  const inner = Math.max(12, opts.width) - 2;
  const rows = [row("", inner), row(label(opts.lang, inner), inner), ...drawn.map((line) => row(` ${line}`, inner)), row("", inner)];
  keep(opts.code, rows);
  return rows;
}

/** The language's name in the top-right corner, then ⧉: /copy copies the block. A padding row above
 *  it keeps it off the pane's top edge. */
function label(lang: string, inner: number): string {
  const name = languageName(lang);
  const named = name === "" ? " " : `${LABEL}${name}${RESET} `;
  return `${" ".repeat(Math.max(0, inner - name.length - 2))}${named}${MARK}${COPY}${RESET}`;
}

/**
 * Soft-wraps a highlighted line at the places an editor would: after a space, a comma, a semicolon
 * or an opening bracket, and before a dot. Only a run with no such place is cut by column.
 */
export function wrapCode(line: string, max: number, hang: number): string[] {
  if (visibleLength(line) <= max) return [line];
  // Segments end at break opportunities; each keeps its own escapes.
  const segments: Array<{ text: string; width: number }> = [];
  let text = "";
  let width = 0;
  const flush = (): void => {
    if (text !== "") segments.push({ text, width });
    text = "";
    width = 0;
  };
  for (const cell of cells(line)) {
    if (!cell.seq && cell.text === "." && width > 0) flush();
    text += cell.text;
    width += cell.width;
    if (!cell.seq && /[\s,;([{]/.test(cell.text)) flush();
  }
  flush();

  const rows: string[] = [];
  const pad = " ".repeat(hang);
  let cur = "";
  let used = 0;
  let active = "";
  for (const segment of segments) {
    let { text: piece, width: w } = segment;
    if (used + w > max && used > (rows.length === 0 ? 0 : hang)) {
      rows.push(cur);
      cur = `${pad}${active}`;
      used = hang;
      // A continuation never starts with the spaces the break left behind.
      piece = piece.replace(LEADING_SPACES, "$1");
      w = visibleLength(piece);
    }
    if (used + w > max) {
      // Every cut part must fit a continuation row, which starts `hang` columns in.
      const parts = wrapAnsi(`${active}${piece}`, Math.max(1, max - hang));
      for (const part of parts.slice(0, -1)) {
        rows.push(`${cur}${part}`);
        cur = pad;
        used = hang;
      }
      piece = parts.at(-1) ?? "";
      w = visibleLength(piece);
    }
    cur += piece;
    used += w;
    for (const seq of piece.match(SGR) ?? []) active = seq === RESET ? "" : `${active}${seq}`;
  }
  rows.push(cur);
  return rows;
}

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const LEADING_SPACES = new RegExp(`^((?:${String.fromCharCode(27)}\\[[0-9;]*m)*) +`);

const NAMES: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", javascript: "JavaScript",
  jsx: "JavaScript JSX", mjs: "JavaScript", cjs: "JavaScript", json: "JSON", jsonc: "JSON with Comments",
  py: "Python", python: "Python", sh: "Shell", shell: "Shell", bash: "Bash", zsh: "Zsh", fish: "Fish",
  console: "Console", rs: "Rust", rust: "Rust", go: "Go", java: "Java", kt: "Kotlin", kotlin: "Kotlin",
  swift: "Swift", c: "C", h: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#", php: "PHP",
  rb: "Ruby", ruby: "Ruby", scala: "Scala", dart: "Dart", zig: "Zig", sql: "SQL", html: "HTML",
  xml: "XML", css: "CSS", scss: "SCSS", md: "Markdown", markdown: "Markdown", yml: "YAML", yaml: "YAML",
  toml: "TOML", ini: "INI", conf: "Config", dockerfile: "Dockerfile", diff: "Diff", patch: "Diff",
  text: "Text", txt: "Text", tree: "Tree", mermaid: "Mermaid", vue: "Vue", svelte: "Svelte", astro: "Astro", htm: "HTML", svg: "SVG",
};

/** The language's full name for the label: "ts" reads "TypeScript". */
export function languageName(lang: string): string {
  if (lang === "") return "";
  return NAMES[lang.toLowerCase()] ?? `${lang[0]?.toUpperCase() ?? ""}${lang.slice(1)}`;
}

/** One panel row: the background, a padding column each side, the content padded to `inner`. */
function row(content: string, inner: number, bg = PANEL): string {
  // A reset inside the content (from wrapping) must not end the background mid-row.
  const body = content.replaceAll(RESET, `${RESET}${bg}`);
  const pad = " ".repeat(Math.max(0, inner - visibleLength(content)));
  return `${bg} ${body}${pad} ${RESET}`;
}
