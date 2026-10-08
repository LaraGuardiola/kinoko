// Styling primitives shared by the TUI views: the ANSI palette and width-aware wrapping that
// keeps colors across split rows.

export const ESC = "\x1b[";
export const ANSI = {
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  reset: `${ESC}0m`,
  inverse: `${ESC}7m`,
  user: `${ESC}38;5;159m`,
  // Amanita muscaria red: the input rules and interruptions.
  amanita: `${ESC}38;2;232;36;36m`,
  // Yellow means "a tool": the dot and the name share it.
  tool: `${ESC}1;38;5;221m`,
  toolDot: `${ESC}38;5;221m`,
  white: `${ESC}1;97m`,
  // Tints only a step away from a dark background, so they read as translucent.
  bgOk: `${ESC}48;2;30;44;38m`,
  bgErr: `${ESC}48;2;50;30;36m`,
};

/**
 * Splits a styled row into escape sequences (width 0) and characters with the number of terminal
 * columns each takes: a wide emoji or CJK character takes two, a combining mark none. Counting a
 * ✅ as one column is what made rows overflow their band.
 */
function* cells(line: string): Generator<{ text: string; width: number; seq: boolean }> {
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        const sequenceEnd = index + end + 3;
        yield { text: line.slice(index, sequenceEnd), width: 0, seq: true };
        index = sequenceEnd;
        continue;
      }
    }
    const code = line.codePointAt(index) ?? 0;
    const text = String.fromCodePoint(code);
    yield { text, width: charWidth(code), seq: false };
    index += text.length;
  }
}

/** Wraps a styled row to the terminal width, keeping ANSI colors across the split rows. */
export function wrapAnsi(line: string, max: number): string[] {
  if (max < 1) return [line];
  if (visibleLength(line) <= max) return [line];
  const rows: string[] = [];
  let cur = "";
  let visible = 0;
  let active = "";
  for (const cell of cells(line)) {
    if (cell.seq) {
      cur += cell.text;
      if (cell.text.endsWith("m")) active = cell.text === ANSI.reset ? "" : active + cell.text;
      continue;
    }
    if (visible + cell.width > max && visible > 0) {
      rows.push(active === "" ? cur : `${cur}${ANSI.reset}`);
      cur = active;
      visible = 0;
    }
    cur += cell.text;
    visible += cell.width;
  }
  rows.push(cur);
  return rows;
}

/** Terminal columns a styled row takes. */
export function visibleLength(line: string): number {
  let visible = 0;
  for (const cell of cells(line)) visible += cell.width;
  return visible;
}

export function clipAnsi(line: string, max: number): string {
  // Rows that already fit (including wrapped transcript rows) pass through untouched:
  // only truly overlong rows are cut, so a trailing reset can never trigger the ellipsis.
  if (visibleLength(line) <= max) return line;
  let out = "";
  let visible = 0;
  for (const cell of cells(line)) {
    if (!cell.seq && visible + cell.width > max - 1) return `${out}…${ANSI.reset}`;
    out += cell.text;
    visible += cell.width;
  }
  return out;
}

// [from, to] code point ranges, sorted. Zero: combining marks, joiners, variation selectors.
const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef],
];
// Two: East Asian wide and fullwidth, plus the emoji that terminals draw two columns wide.
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
  for (const [from, to] of ranges) {
    if (code < from) return false;
    if (code <= to) return true;
  }
  return false;
}

/** Columns one code point takes in a terminal. */
export function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code < 0x300) return 1;
  if (code === 0x200d || inRanges(code, ZERO)) return 0;
  return inRanges(code, WIDE) ? 2 : 1;
}
