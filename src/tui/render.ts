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
const ERASE_LINE = `${ESC}K`;
const RESET = `${ESC}0m`;
/** Printed lines kept for redrawing the screen after a resize. */
const HISTORY = 2000;
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;

export interface RenderState {
  /** Rows of the live region, top to bottom, already styled. */
  lines: string[];
  /** Cursor position inside those rows, zero-based (the terminal column is col + 1). */
  row: number;
  col: number;
  /** A column on the right of the screen, from its top row down beside the region's upper rows. */
  side?: SideSpec;
}

/**
 * The side column (the plan and the changes). It is drawn with absolute positions over the screen's
 * right columns, so the renderer must know which screen row the region starts on: the terminal
 * tells it (`requestPosition`), and it keeps count from there.
 */
export interface SideSpec {
  /** 1-based screen column where the column starts; it ends one before the last. */
  col: number;
  /** The region's rows above the input's rule: the column runs down beside them, no further. */
  upper: number;
  /** The column's rows for a height. */
  rows: (height: number) => string[];
  /** Changes whenever what the column shows does: frames compare it, not the function. */
  key: string;
  /** Columns printed text may take beside it. */
  text: number;
}

export interface RendererOptions {
  write: (text: string) => void;
  columns?: () => number;
  /** The terminal's rows (the side column is drawn from the top one). */
  rows?: () => number;
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
  #rows: () => number;
  /** The screen row (1-based) the region starts on; undefined until the terminal said where. */
  #top: number | undefined;
  /** The side column as last drawn, to erase it before the screen scrolls. */
  #sideDrawn: { col: number; height: number } | undefined;
  #paintedRows: number | undefined;
  /** A position asked for and not answered yet: the cursor row and top at the time. */
  #asked: { row: number; top: number | undefined } | undefined;
  /** What was printed, for redrawing the screen after a resize the side column was on. */
  #history: string[] = [];
  #lastSideErased = false;

  /** The screen row (1-based) the region starts on, once the terminal has said. */
  get top(): number | undefined {
    return this.#top;
  }

  constructor(opts: RendererOptions) {
    this.#write = opts.write;
    this.#minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
    this.#now = opts.now ?? (() => performance.now());
    this.#columns = opts.columns ?? (() => 80);
    this.#rows = opts.rows ?? (() => 24);
  }

  /** Asks the terminal where the cursor is (it answers `CSI row;col R`, see `position`). */
  requestPosition(): void {
    this.#asked = { row: this.#cursorRow, top: this.#top };
    this.#write(`${ESC}6n`);
  }

  /** The terminal's answer: the cursor was on the editor row, so the region starts that much above. */
  position(screenRow: number): void {
    // Unasked (or asked before the last paint), the cursor is still parked on the editor row.
    const asked = this.#asked ?? { row: this.#cursorRow, top: this.#top };
    this.#asked = undefined;
    // Paints since the question moved the region: add what they moved it by.
    const moved = asked.top !== undefined && this.#top !== undefined ? this.#top - asked.top : 0;
    this.#top = Math.max(1, screenRow - asked.row + moved);
    this.#dirty = true;
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
    // The window changed size under the side column: the terminal re-wrapped the screen, column
    // and all. Start the screen again from what was printed.
    if (this.#sideDrawn && (this.#columns() !== this.#paintedCols || this.#rows() !== this.#paintedRows)) {
      this.#redraw();
      return;
    }
    this.#write(`${SYNC_START}${this.#eraseSide()}${this.#moveToTop()}${CLEAR_BELOW}${this.#paint()}${SYNC_END}`);
  }

  /**
   * Prints finished content above the live region. The region is wiped, the text is written
   * where the region used to start (the terminal scrolls by itself when it reaches the bottom)
   * and the region is repainted below it. History is never rewritten, so it stays in scrollback.
   */
  printAbove(text: string): void {
    if (text === "") return;
    const lines = text.split("\n");
    this.#history.push(...lines);
    if (this.#history.length > HISTORY) this.#history.splice(0, this.#history.length - HISTORY);
    const rows = lines.flatMap((line) => wrapAnsi(line, this.#textWidth()));
    const body = rows.map((line) => ` ${line}`).join("\r\n");
    // The side column goes first: the rows about to scroll into the scrollback leave it behind.
    const out = `${SYNC_START}${this.#eraseSide()}${this.#moveToTop()}${CLEAR_BELOW}${body}\r\n`;
    if (this.#top !== undefined) this.#top += rows.length;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${out}${this.#paint()}${SYNC_END}`);
  }

  /** Wipes the screen and the terminal's scrollback (/clear): the region starts again on the top row. */
  clear(): void {
    this.#history = [];
    this.#sideDrawn = undefined;
    this.#lastSideErased = false;
    this.#top = 1;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${SYNC_START}${RESET}${ESC}H${ESC}2J${ESC}3J${this.#paint()}${SYNC_END}`);
  }

  /** Leaves the cursor on a fresh row under the region, e.g. before the process exits. */
  release(): void {
    const erase = this.#eraseSide();
    const down = this.#drawn.length - 1 - this.#cursorRow;
    const back = erase === "" ? (down > 0 ? `${ESC}${down}B` : "") : `${ESC}${(this.#top ?? 1) + this.#drawn.length - 1};1H`;
    this.#write(`${erase}${back}\r\n${SHOW_CURSOR}`);
    this.#drawn = [];
    this.#cursorRow = 0;
  }

  /** Columns printed text takes: beside the side column, or the screen less its margins. */
  #textWidth(): number {
    return Math.max(1, this.#state.side?.text ?? this.#columns() - 2);
  }

  /** Erases the side column as last drawn (the cursor is lost: the caller moves it absolutely). */
  #eraseSide(): string {
    const drawn = this.#sideDrawn;
    this.#sideDrawn = undefined;
    if (drawn === undefined) return "";
    let out = RESET;
    for (let row = 1; row <= drawn.height; row++) out += `${ESC}${row};${drawn.col}H${ERASE_LINE}`;
    this.#lastSideErased = true;
    return `${out}${ESC}${this.#top ?? 1};1H`;
  }

  /**
   * After a resize with the side column on: the screen again from the top, the last printed rows
   * wrapped to the new width, then the region. What the terminal's re-wrap pushed into the
   * scrollback before this stays there.
   */
  #redraw(): void {
    this.#sideDrawn = undefined;
    const room = Math.max(0, this.#rows() - this.#state.lines.length);
    const rows = this.#history.flatMap((line) => wrapAnsi(line, this.#textWidth())).slice(-room);
    const body = rows.map((line) => ` ${line}\r\n`).join("");
    this.#top = rows.length + 1;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${SYNC_START}${RESET}${ESC}H${ESC}2J${body}${this.#paint()}${SYNC_END}`);
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
    // Erasing the side column left the cursor at the region's top already.
    if (this.#lastSideErased) {
      this.#lastSideErased = false;
      return "\r";
    }
    const cols = this.#columns();
    const shrunk = this.#paintedCols !== undefined && cols < this.#paintedCols;
    const up = shrunk ? reflowedUp(this.#drawn, this.#cursorRow, this.#cursorCol, cols) : this.#cursorRow;
    return `${up > 0 ? `${ESC}${up}A` : ""}\r`;
  }

  /** Writes the region from the cursor (already at its top, nothing below) and parks the cursor. */
  #paint(): string {
    const { lines, row, col, side } = this.#state;
    this.#dirty = false;
    this.#lastSideErased = false;
    this.#lastAt = this.#now();
    this.#drawn = [...lines];
    this.#cursorRow = 0;
    this.#cursorCol = 0;
    this.#paintedCols = this.#columns();
    this.#paintedRows = this.#rows();
    if (lines.length === 0) return "";
    let out = lines.map((line) => ` ${line}`).join("\r\n");
    // A region that runs past the bottom scrolled the screen: it starts that much higher now.
    if (this.#top !== undefined) this.#top = Math.max(1, Math.min(this.#top, this.#rows() - lines.length + 1));
    if (side !== undefined && this.#top !== undefined) {
      const height = this.#top - 1 + side.upper;
      if (height > 0) {
        out += side.rows(height).map((r, i) => `${ESC}${i + 1};${side.col}H${r}`).join("");
        this.#sideDrawn = { col: side.col, height };
      }
      out += `${ESC}${this.#top + row};${col + 2}H`;
      this.#cursorRow = row;
      this.#cursorCol = col;
      return out;
    }
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
    a.side?.key === b.side?.key &&
    a.side?.col === b.side?.col &&
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
