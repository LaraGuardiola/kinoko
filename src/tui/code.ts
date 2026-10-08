// A fenced code block drawn like an editor pane: a panel with its own background, the language
// on the top row, a line-number gutter and syntax colours. Long lines wrap inside the panel with
// an empty gutter, so the background never breaks.

import { highlightLine } from "./highlight.ts";
import type { HighlightState } from "./highlight.ts";
import { visibleLength, wrapAnsi } from "./style.ts";

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
  const rows: string[] = [row(opts.lang === "" ? "" : `${LABEL}${opts.lang}${RESET}`, inner)];
  let state: HighlightState = {};
  lines.forEach((line, index) => {
    const lit = highlightLine(line, opts.lang, state);
    state = lit.state;
    const pieces = wrapAnsi(lit.text, codeWidth);
    pieces.forEach((piece, n) => {
      const number = n === 0 ? String(index + 1).padStart(digits) : " ".repeat(digits);
      rows.push(row(`${GUTTER}${number}${FG_OFF}  ${piece}`, inner));
    });
  });
  rows.push(row("", inner));
  return rows;
}

/** One panel row: the background, a padding column each side, the content padded to `inner`. */
function row(content: string, inner: number): string {
  // A reset inside the content (from wrapping) must not end the background mid-row.
  const body = content.replaceAll(RESET, `${RESET}${PANEL}`);
  const pad = " ".repeat(Math.max(0, inner - visibleLength(content)));
  return `${PANEL} ${body}${pad} ${RESET}`;
}
