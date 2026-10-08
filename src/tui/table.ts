// Markdown tables as box-drawn grids. Columns take their natural width; when the grid is wider
// than the terminal the widest columns give way and their cells wrap by word.

import { visibleLength, wrapWords } from "./style.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BORDER = `${ESC}38;2;92;98;124m`;
const HEAD = `${ESC}1m${ESC}38;2;238;222;186m`;

type Align = "left" | "center" | "right";

/** Is `lines[i]` the header of a table (a row followed by a `| --- |` separator)? */
export function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? "";
  const sep = lines[i + 1] ?? "";
  return head.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sep);
}

/** Splits a table row into trimmed cells; `\|` stays a literal pipe. */
export function cellsOf(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * Renders the table whose source rows are `rows` (header, separator, body...). `inline` formats
 * a cell's markdown; `color` off draws the same grid without escapes.
 */
export function renderTable(rows: string[], width: number, inline: (text: string) => string, color = true): string[] {
  const head = cellsOf(rows[0] ?? "");
  const aligns: Align[] = cellsOf(rows[1] ?? "").map((spec) =>
    spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : "left",
  );
  const body = rows.slice(2).map(cellsOf);
  const columns = Math.max(head.length, ...body.map((cells) => cells.length));
  const grid = [head, ...body].map((cells) => Array.from({ length: columns }, (_, c) => inline(cells[c] ?? "")));

  // Natural widths, then shrink the widest column until the grid fits: "│ a │ b │" is 3c+1 wide.
  const widths = Array.from({ length: columns }, (_, c) => Math.max(1, ...grid.map((cells) => visibleLength(cells[c] ?? ""))));
  const room = Math.max(columns * 3, width - (3 * columns + 1));
  while (widths.reduce((sum, w) => sum + w, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 3) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
  }

  const b = (text: string): string => (color ? `${BORDER}${text}${RESET}` : text);
  const rule = (left: string, mid: string, right: string): string => b(`${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`);
  const out = [rule("┌", "┬", "┐")];
  grid.forEach((cells, r) => {
    const wrapped = cells.map((cell, c) => wrapWords(cell, widths[c] ?? 1));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      const parts = wrapped.map((lines, c) => {
        const text = lines[line] ?? "";
        const styled = r === 0 && color ? `${HEAD}${text.replaceAll(RESET, `${RESET}${HEAD}`)}${RESET}` : text;
        return align(styled, widths[c] ?? 1, r === 0 ? "left" : (aligns[c] ?? "left"));
      });
      out.push(`${b("│")} ${parts.join(` ${b("│")} `)} ${b("│")}`);
    }
    if (r === 0) out.push(rule("├", "┼", "┤"));
  });
  out.push(rule("└", "┴", "┘"));
  return out;
}

function align(text: string, width: number, how: Align): string {
  const gap = Math.max(0, width - visibleLength(text));
  if (how === "right") return `${" ".repeat(gap)}${text}`;
  if (how === "center") return `${" ".repeat(Math.floor(gap / 2))}${text}${" ".repeat(Math.ceil(gap / 2))}`;
  return `${text}${" ".repeat(gap)}`;
}
