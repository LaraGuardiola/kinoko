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
  // Yellow means "a tool": the dot and the name share it.
  tool: `${ESC}1;38;5;221m`,
  toolDot: `${ESC}38;5;221m`,
  white: `${ESC}1;97m`,
  // Tints only a step away from a dark background, so they read as translucent.
  bgOk: `${ESC}48;2;30;44;38m`,
  bgErr: `${ESC}48;2;50;30;36m`,
};

/** Wraps a styled row to the terminal width, keeping ANSI colors across the split rows. */
export function wrapAnsi(line: string, max: number): string[] {
  if (max < 1) return [line];
  if (visibleLength(line) <= max) return [line];
  const rows: string[] = [];
  let cur = "";
  let visible = 0;
  let active = "";
  let index = 0;
  while (index < line.length) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        const sequenceEnd = index + end + 3;
        const seq = line.slice(index, sequenceEnd);
        cur += seq;
        if (seq.endsWith("m")) active = seq === ANSI.reset ? "" : active + seq;
        index = sequenceEnd;
        continue;
      }
    }
    if (visible >= max) {
      rows.push(active === "" ? cur : `${cur}${ANSI.reset}`);
      cur = active;
      visible = 0;
      continue;
    }
    cur += line[index] ?? "";
    visible++;
    index++;
  }
  rows.push(cur);
  return rows;
}

export function visibleLength(line: string): number {
  let visible = 0;
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        index += end + 3;
        continue;
      }
    }
    visible++;
    index++;
  }
  return visible;
}

export function clipAnsi(line: string, max: number): string {
  // Rows that already fit (including wrapped transcript rows) pass through untouched:
  // only truly overlong rows are cut, so a trailing reset can never trigger the ellipsis.
  if (visibleLength(line) <= max) return line;
  let out = "";
  let visible = 0;
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        const sequenceEnd = index + end + 3;
        out += line.slice(index, sequenceEnd);
        index = sequenceEnd;
        continue;
      }
    }
    if (visible >= max - 1 && index < line.length - 1) return `${out}…${ANSI.reset}`;
    out += line[index] ?? "";
    visible++;
    index++;
  }
  return out;
}
