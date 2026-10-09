// The live region: a few lines at the bottom of the terminal that we repaint in place.
//
// No alternate screen, so the native scrollback keeps everything. The region is addressed with
// RELATIVE cursor moves only ("go up N rows from where I left the cursor"), never with absolute
// rows. That is what lets the terminal scroll for real: whatever is printed above the region
// becomes ordinary scrollback, and the user can scroll up through it while the model streams.
//
// Contract with the caller: the region must be shorter than the terminal (liveRegion guarantees
// it), otherwise its top scrolls out of reach and cannot be repainted.

import { wrapAnsi } from "./view.ts";
import { visibleLength } from "./style.ts";

const ESC = "\x1b[";
const CLEAR_BELOW = `${ESC}J`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
// Synchronized output: terminals that know it paint the whole update at once (no flicker);
// the others ignore it.
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

export interface RenderState {
  /** Rows of the live region, top to bottom, already styled. */
  lines: string[];
  /** Cursor position inside those rows, zero-based (the terminal column is col + 1). */
  row: number;
  col: number;
}

export interface RendererOptions {
  write: (text: string) => void;
  columns?: () => number;
  /** Minimum gap between repaints, in ms. ~30fps. */
  minIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_INTERVAL = 33;

export class Renderer {
  #write: (text: string) => void;
  #minInterval: number;
  #now: () => number;
  #columns: () => number;
  #drawn: string[] = [];
  /** Where we left the cursor, in rows below the top of the drawn region, and its column. */
  #cursorRow = 0;
  #cursorCol = 0;
  /** The terminal's width when the region was drawn: a narrower one has re-wrapped its rows. */
  #paintedCols: number | undefined;
  #lastAt = 0;
  #dirty = false;
  #state: RenderState = { lines: [], row: 0, col: 0 };

  constructor(opts: RendererOptions) {
    this.#write = opts.write;
    this.#minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
    this.#now = opts.now ?? (() => performance.now());
    this.#columns = opts.columns ?? (() => 80);
  }

  /** What should be on screen now. Cheap: nothing is drawn until `frame()`. */
  update(state: RenderState): void {
    // An identical frame is not dirty: streaming sends the same state often, and repainting it
    // only makes the terminal flicker.
    if (sameState(this.#state, state)) return;
    this.#state = state;
    this.#dirty = true;
  }

  /** Repaints when something changed and the throttle allows it. Call from a timer. */
  frame(): boolean {
    if (!this.#dirty) return false;
    if (this.#now() - this.#lastAt < this.#minInterval) return false;
    this.flush();
    return true;
  }

  /** Repaints right now, ignoring the throttle (used on resize and before printing above). */
  flush(): void {
    this.#write(`${SYNC_START}${this.#moveToTop()}${CLEAR_BELOW}${this.#paint()}${SYNC_END}`);
  }

  /**
   * Prints finished content above the live region. The region is wiped, the text is written
   * where the region used to start (the terminal scrolls by itself when it reaches the bottom)
   * and the region is repainted below it. History is never rewritten, so it stays in scrollback.
   */
  printAbove(text: string): void {
    if (text === "") return;
    const rows = text.split("\n").flatMap((line) => wrapAnsi(line, Math.max(1, this.#columns() - 2)));
    const body = rows.map((line) => ` ${line}`).join("\r\n");
    const out = `${SYNC_START}${this.#moveToTop()}${CLEAR_BELOW}${body}\r\n`;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${out}${this.#paint()}${SYNC_END}`);
  }

  /** Leaves the cursor on a fresh row under the region, e.g. before the process exits. */
  release(): void {
    const down = this.#drawn.length - 1 - this.#cursorRow;
    this.#write(`${down > 0 ? `${ESC}${down}B` : ""}\r\n${SHOW_CURSOR}`);
    this.#drawn = [];
    this.#cursorRow = 0;
  }

  /** The rows currently on screen, for tests. */
  get drawn(): string[] {
    return [...this.#drawn];
  }

  /**
   * Escape that puts the cursor on the first column of the region's top row. After the window got
   * narrower, the terminal has re-wrapped (reflowed) the rows drawn wider than it now is, and the
   * cursor moved with them: the way up is then longer than the rows that were drawn.
   */
  #moveToTop(): string {
    const cols = this.#columns();
    const shrunk = this.#paintedCols !== undefined && cols < this.#paintedCols;
    const up = shrunk ? reflowedUp(this.#drawn, this.#cursorRow, this.#cursorCol, cols) : this.#cursorRow;
    return `${up > 0 ? `${ESC}${up}A` : ""}\r`;
  }

  /** Writes the region from the cursor (already at its top, nothing below) and parks the cursor. */
  #paint(): string {
    const { lines, row, col } = this.#state;
    this.#dirty = false;
    this.#lastAt = this.#now();
    this.#drawn = [...lines];
    this.#cursorRow = 0;
    this.#cursorCol = 0;
    this.#paintedCols = this.#columns();
    if (lines.length === 0) return "";
    let out = lines.map((line) => ` ${line}`).join("\r\n");
    // The cursor is after the last row now; walk back up to the editor row.
    const up = lines.length - 1 - row;
    if (up > 0) out += `${ESC}${up}A`;
    out += `${ESC}${col + 2}G`;
    this.#cursorRow = row;
    this.#cursorCol = col;
    return out;
  }
}

/**
 * Rows from the cursor up to the region's top once a terminal `cols` wide has reflowed it: each row
 * drawn above the cursor's (with the renderer's one-column margin) now takes as many rows as it
 * needs, and the cursor sits on the wrapped part of its own row that holds its column.
 */
export function reflowedUp(drawn: string[], row: number, col: number, cols: number): number {
  const width = Math.max(1, cols);
  const above = drawn.slice(0, row).reduce((n, line) => n + Math.max(1, Math.ceil((visibleLength(line) + 1) / width)), 0);
  return above + Math.floor((col + 1) / width);
}

function sameState(a: RenderState, b: RenderState): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

/** Cursor helpers, used by the demo. */
export const ansi = {
  hide: HIDE_CURSOR,
  show: SHOW_CURSOR,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  reset: `${ESC}0m`,
  inverse: `${ESC}7m`,
  clearScreen: `${ESC}2J${ESC}H`,
};
