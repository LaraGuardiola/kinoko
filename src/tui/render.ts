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
  /** What was printed, for redrawing the screen at a new width: each piece's lines as printed and,
   *  when the caller gave one, how to draw it again at another width (a reply, a tool's band). */
  #history: Printed[] = [];
  /** The last rows printed above the region, as written (margin included): what a click lands on. */
  #printed: string[] = [];
  #lastSideErased = false;
  /** Rows ever printed (an absolute count), and the pieces kept by key, to rewrite in place. */
  #rowsOut = 0;
  /** After the user's shell: its output, full width, is on screen until kinoko has printed this
   *  many rows (or redrawn the screen); the side column waits, not to be drawn over it. */
  #foreignUntil = 0;
  /** All the scrollback is kinoko's and still in #history: a resize can print it again whole. */
  #whole = true;
  #blocks = new Map<string, Printed>();
  /** The text width the screen was last drawn at: another one redraws it. */
  #paintedText: number | undefined;

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
    // Any other width (the window's, or the text's when the side column comes or goes): the screen
    // is drawn again from what was printed, each piece at the new width.
    const width = this.#columns() !== this.#paintedCols || (this.#paintedText !== undefined && this.#textWidth() !== this.#paintedText);
    if (this.#paintedCols !== undefined && (width || (this.#sideDrawn && this.#rows() !== this.#paintedRows))) {
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
  printAbove(text: string, key?: string, source?: (width: number) => string): void {
    if (text === "") return;
    const lines = text.split("\n");
    const rows = lines.flatMap((line) => wrapAnsi(line, this.#textWidth()));
    const entry: Printed = { lines, source, row: this.#rowsOut, rows: rows.length };
    this.#remember(entry, key);
    const body = rows.map((line) => ` ${line}`).join("\r\n");
    this.#keepPrinted(rows);
    // The side column goes first: the rows about to scroll into the scrollback leave it behind.
    const out = `${SYNC_START}${this.#eraseSide()}${this.#moveToTop()}${CLEAR_BELOW}${body}\r\n`;
    if (this.#top !== undefined) this.#top += rows.length;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${out}${this.#paint()}${SYNC_END}`);
  }

  /** Wipes the screen and the terminal's scrollback (/clear): the region starts again on the top row. */
  clear(): void {
    this.#blocks.clear();
    this.#paintedText = undefined;
    this.#history = [];
    this.#whole = true;
    this.#printed = [];
    this.#sideDrawn = undefined;
    this.#lastSideErased = false;
    this.#top = 1;
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${SYNC_START}${RESET}${ESC}H${ESC}2J${ESC}3J${this.#paint()}${SYNC_END}`);
  }

  /**
   * Hands the screen over (to the user's shell): the region and the side column are wiped and the
   * cursor is left where the region started. `resume()` paints it again wherever the cursor is then.
   */
  suspend(): void {
    this.#write(`${SYNC_START}${this.#eraseSide()}${this.#moveToTop()}${CLEAR_BELOW}${SHOW_CURSOR}${SYNC_END}`);
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#top = undefined;
  }

  /** The screen is back: the region is painted on the cursor's row, and its place asked for. */
  resume(): void {
    this.#foreignUntil = this.#rowsOut + this.#rows();
    this.#whole = false; // what ran in between is in the scrollback, not in #history
    this.#dirty = true;
    this.flush();
    this.requestPosition();
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

  /**
   * What screen row `y` (1-based) shows, as written: a printed row above the region, or one of the
   * region's. Undefined while the terminal has not said where the region is, or for a row never
   * written. Column `x` (1-based) of the screen is cell `x - 1` of it (the margin is included).
   */
  rowAt(y: number): string | undefined {
    if (this.#top === undefined) return undefined;
    if (y >= this.#top) {
      const line = this.#drawn[y - this.#top];
      return line === undefined ? undefined : ` ${line}`;
    }
    return this.#printed.at(y - this.#top);
  }

  /**
   * Rewrites a block printed with `key` in place (the startup panel's capabilities), keeping its
   * row count on screen: when the new text needs more rows, each line is cut instead. The history (what a redraw prints)
   * follows; the screen only while the block is still on it. False when its first row is not on
   * screen any more (scrolled into the scrollback, or wiped): the caller prints it anew.
   */
  rewrite(key: string, text: string, source?: (width: number) => string): boolean {
    const block = this.#blocks.get(key);
    const lines = text.split("\n");
    if (block === undefined) return false;
    // What a redraw prints follows (its lines may be more or fewer: the rows on screen stay).
    block.lines = lines;
    block.source = source;
    const width = this.#textWidth();
    let rows = lines.flatMap((line) => wrapAnsi(line, width));
    if (rows.length > block.rows) rows = lines.map((line) => cut(line, width));
    while (rows.length < block.rows) rows.push("");
    rows = rows.slice(0, block.rows);
    const at = this.#printed.length - (this.#rowsOut - block.row);
    for (const [i, row] of rows.entries()) if (at + i >= 0 && at + i < this.#printed.length) this.#printed[at + i] = ` ${row}`;
    if (this.#top === undefined) return false;
    // Its first row's place on the screen: the region's top, less the rows printed since.
    const screen = this.#top - (this.#rowsOut - block.row);
    if (screen < 1) return false;
    let out = "\x1b7"; // the cursor goes back where it was
    for (const [i, row] of rows.entries()) {
      const pad = Math.max(0, width - visibleLength(row));
      out += `${ESC}${screen + i};1H${RESET} ${row}${RESET}${" ".repeat(pad)}`;
    }
    this.#write(`${SYNC_START}${out}\x1b8${SYNC_END}`);
    return true;
  }

  /** Keeps a printed piece (and its key) in the history, the oldest going past HISTORY lines. */
  #remember(entry: Printed, key?: string): void {
    if (key !== undefined) this.#blocks.set(key, entry);
    this.#history.push(entry);
    let lines = this.#history.reduce((n, e) => n + e.lines.length, 0);
    while (lines > HISTORY && this.#history.length > 1) {
      const gone = this.#history.shift()!;
      this.#whole = false;
      lines -= gone.lines.length;
      for (const [k, e] of this.#blocks) if (e === gone) this.#blocks.delete(k);
    }
  }

  #keepPrinted(rows: string[]): void {
    this.#rowsOut += rows.length;
    this.#printed.push(...rows.map((line) => ` ${line}`));
    if (this.#printed.length > 500) this.#printed.splice(0, this.#printed.length - 500);
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
   * After a resize (any new width, or new height with the side column on): the screen again from
   * the top, what was printed wrapped to the new width, then the region. The terminal re-wrapped
   * the scrollback itself, splitting each full-width band into ragged rows: when kinoko still has
   * all of it, the scrollback is wiped and printed again whole; else only the screen's rows are.
   */
  #redraw(): void {
    this.#sideDrawn = undefined;
    this.#foreignUntil = 0; // the screen is all kinoko's again
    const room = Math.max(0, this.#rows() - this.#state.lines.length);
    const width = this.#textWidth();
    // Each piece drawn again at this width when it can be (a reply rewraps, a band refills), else
    // its lines as printed, rewrapped.
    const wrapped = this.#history.map((entry) => {
      if (entry.source) entry.lines = entry.source(width).split("\n");
      return entry.lines.flatMap((line) => wrapAnsi(line, width));
    });
    const all = wrapped.flat();
    const whole = this.#whole;
    const rows = whole ? all : all.slice(-room);
    // Where each piece's rows are now (above the screen when cut off), for a rewrite in place.
    let before = this.#rowsOut - (all.length - rows.length);
    for (const [i, entry] of this.#history.entries()) {
      entry.row = before;
      entry.rows = wrapped[i]?.length ?? 0;
      before += entry.rows;
    }
    const body = rows.map((line) => ` ${line}\r\n`).join("");
    this.#printed = [];
    this.#keepPrinted(rows);
    this.#top = rows.length + 1; // past the bottom when whole: #paint brings it back on screen
    this.#drawn = [];
    this.#cursorRow = 0;
    this.#write(`${SYNC_START}${RESET}${ESC}H${ESC}2J${whole ? `${ESC}3J` : ""}${body}${this.#paint()}${SYNC_END}`);
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
    this.#paintedText = this.#textWidth();
    this.#paintedRows = this.#rows();
    if (lines.length === 0) return "";
    let out = lines.map((line) => ` ${line}`).join("\r\n");
    // A region that runs past the bottom scrolled the screen: it starts that much higher now.
    if (this.#top !== undefined) this.#top = Math.max(1, Math.min(this.#top, this.#rows() - lines.length + 1));
    if (side !== undefined && this.#top !== undefined && this.#rowsOut >= this.#foreignUntil) {
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

/** A styled line cut to `width` columns, an ellipsis at the end when it was longer. */
function cut(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  return `${wrapAnsi(line, Math.max(1, width - 1))[0] ?? ""}…`;
}

/** A piece printed above the region: its lines, how to draw it at another width, its rows. */
interface Printed {
  lines: string[];
  source?: (width: number) => string;
  /** Its first row's absolute index, and how many rows it took. */
  row: number;
  rows: number;
}
