// A fenced code block drawn like an editor pane: a panel with its own background, the language's
// full name in the top-right corner, a line-number gutter and syntax colours. Long lines soft-wrap
// at token boundaries with a hanging indent, so the background never breaks.

import { highlightLine } from "./highlight.ts";
import type { HighlightState } from "./highlight.ts";
import { cells, visibleLength, wrapAnsi } from "./style.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const PANEL = `${ESC}48;2;36;38;52m`;
const GUTTER = `${ESC}38;2;92;98;124m`;
const LABEL = `${ESC}3m${ESC}38;2;150;156;182m`;
const FG_OFF = `${ESC}39m`;

export interface CodeOptions {
  lang: string;
  /** Columns the panel spans (the transcript width). */
  width: number;
  color?: boolean;
}

/** The panel's rows for a code block's lines (fences excluded). */
export function codeBlock(lines: string[], opts: CodeOptions): string[] {
  const color = opts.color ?? true;
  if (!color) return lines.map((line) => `  ${line}`);
  const width = Math.max(12, opts.width);
  const digits = String(Math.max(1, lines.length)).length;
  // " 12  code…  ": one column of padding each side, the gutter, two spaces before the code.
  const inner = width - 2;
  const codeWidth = Math.max(4, inner - digits - 2);
  const name = languageName(opts.lang);
  // The language sits in the top-right corner, a couple of columns in from the edge.
  const label = name === "" ? "" : `${" ".repeat(Math.max(0, inner - name.length - 2))}${LABEL}${name}${RESET}`;
  // A padding row above the label keeps it off the pane's top edge.
  const rows: string[] = [row("", inner), row(label, inner)];
  let state: HighlightState = {};
  lines.forEach((line, index) => {
    const lit = highlightLine(line, opts.lang, state);
    state = lit.state;
    // A continuation row hangs two columns deeper than the line's own indentation, like an editor's
    // soft wrap, so it reads as the same line and not as the next one.
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const pieces = wrapCode(lit.text, codeWidth, Math.min(indent + 2, Math.floor(codeWidth / 2)));
    pieces.forEach((piece, n) => {
      const number = n === 0 ? String(index + 1).padStart(digits) : " ".repeat(digits);
      rows.push(row(`${GUTTER}${number}${FG_OFF}  ${piece}`, inner));
    });
  });
  rows.push(row("", inner));
  return rows;
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
  text: "Text", txt: "Text",
};

/** The language's full name for the label: "ts" reads "TypeScript". */
export function languageName(lang: string): string {
  if (lang === "") return "";
  return NAMES[lang.toLowerCase()] ?? `${lang[0]?.toUpperCase() ?? ""}${lang.slice(1)}`;
}

/** One panel row: the background, a padding column each side, the content padded to `inner`. */
function row(content: string, inner: number): string {
  // A reset inside the content (from wrapping) must not end the background mid-row.
  const body = content.replaceAll(RESET, `${RESET}${PANEL}`);
  const pad = " ".repeat(Math.max(0, inner - visibleLength(content)));
  return `${PANEL} ${body}${pad} ${RESET}`;
}
