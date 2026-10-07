// The live region: a few lines at the bottom of the terminal that we repaint in place.
//
// No alternate screen, so the native scrollback keeps everything that scrolls off the top. Only
// the live region is ever rewritten; `printAbove` moves it out of the way, prints finished content,
// and lets the region redraw underneath.

const ESC = "\x1b[";
const CLEAR_LINE = `${ESC}2K\r`;
const CLEAR_BELOW = `${ESC}J`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

export interface RenderState {
  /** Rows of the live region, top to bottom, already styled. */
  lines: string[];
  /** Cursor position inside those rows, zero-based (the terminal column is col + 1). */
  row: number;
  col: number;
}

export interface RendererOptions {
  write: (text: string) => void;
  /** Minimum gap between repaints, in ms. ~30fps. */
  minIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_INTERVAL = 33;

export class Renderer {
  #write: (text: string) => void;
  #minInterval: number;
  #now: () => number;
  #drawn: string[] = [];
  #drawnRow = 0;
  #lastAt = 0;
  #dirty = false;
  #state: RenderState = { lines: [], row: 0, col: 0 };

  constructor(opts: RendererOptions) {
    this.#write = opts.write;
    this.#minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
    this.#now = opts.now ?? (() => performance.now());
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
    this.#draw();
    return true;
  }

  /** Repaints right now, ignoring the throttle (used before printing something above). */
  flush(): void {
    this.#draw();
  }

  /** Prints finished content above the live region, then lets the region redraw below it. */
  printAbove(text: string): void {
    this.#erase();
    this.#write(`${text}\n`);
    this.#drawn = [];
    this.#dirty = true;
    this.#draw();
  }

  /** The rows currently on screen, for tests. */
  get drawn(): string[] {
    return [...this.#drawn];
  }

  #draw(): void {
    const lines = this.#state.lines;
    let out = this.#drawn.length > 0 && this.#drawnRow > 0 ? `\x1b[${this.#drawnRow}A` : "";
    for (const [index, line] of lines.entries()) {
      out += `${CLEAR_LINE}${line}`;
      // A newline after the bottom row scrolls a full-height live region on every keypress.
      if (index < lines.length - 1) out += "\n";
    }
    // Anything left from a taller previous frame has to go.
    out += CLEAR_BELOW;
    // Come back up to the cursor row and place it.
    const up = lines.length - 1 - this.#state.row;
    if (up > 0) out += `\x1b[${up}A`;
    out += `\x1b[${this.#state.col + 1}G`; // terminals count columns from 1
    this.#write(out);
    this.#drawn = [...lines];
    this.#drawnRow = this.#state.row;
    this.#dirty = false;
    this.#lastAt = this.#now();
  }

  #erase(): void {
    if (this.#drawn.length === 0) return;
    let out = this.#drawnRow > 0 ? `\x1b[${this.#drawnRow}A` : "";
    for (let row = 0; row < this.#drawn.length; row++) {
      out += CLEAR_LINE;
      if (row < this.#drawn.length - 1) out += "\n";
    }
    if (this.#drawn.length > 1) out += `\x1b[${this.#drawn.length - 1}A`;
    this.#write(out);
  }
}

function sameState(a: RenderState, b: RenderState): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

/** Cursor helpers, used by the demo and by phase 9. */
export const ansi = {
  hide: HIDE_CURSOR,
  show: SHOW_CURSOR,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  reset: `${ESC}0m`,
  inverse: `${ESC}7m`,
  clearScreen: `${ESC}2J${ESC}H`,
};
