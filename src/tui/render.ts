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
  columns?: () => number;
  rows?: () => number;
  topRow?: () => number;
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
  #rows: () => number;
  #topRow: () => number;
  #drawn: string[] = [];
  #lastAt = 0;
  #dirty = false;
  #state: RenderState = { lines: [], row: 0, col: 0 };

  constructor(opts: RendererOptions) {
    this.#write = opts.write;
    this.#minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
    this.#now = opts.now ?? (() => performance.now());
    this.#columns = opts.columns ?? (() => 80);
    this.#rows = opts.rows ?? (() => 24);
    this.#topRow = opts.topRow ?? (() => 1);
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
    this.#write(`${wrap(text, Math.max(1, this.#columns() - 2)).map((line) => ` ${line}`).join("\n")}\n`);
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
    const startRow = Math.min(this.#rows(), Math.max(1, this.#topRow()));
    let out = `\x1b[${startRow};1H`;
    for (const [index, line] of lines.entries()) {
      out += `${CLEAR_LINE} ${line}`;
      // A newline after the bottom row scrolls a full-height live region on every keypress.
      if (index < lines.length - 1) out += "\n";
    }
    // Anything left from a taller previous frame has to go.
    out += CLEAR_BELOW;
    // Come back up to the cursor row and place it.
    out += `\x1b[${startRow + this.#state.row};${this.#state.col + 2}H`;
    this.#write(out);
    this.#drawn = [...lines];
    this.#dirty = false;
    this.#lastAt = this.#now();
  }

  #erase(): void {
    if (this.#drawn.length === 0) return;
    const startRow = Math.min(this.#rows(), Math.max(1, this.#topRow()));
    let out = `\x1b[${startRow};1H`;
    for (let row = 0; row < this.#drawn.length; row++) {
      out += CLEAR_LINE;
      if (row < this.#drawn.length - 1) out += "\n";
    }
    if (this.#drawn.length > 1) out += `\x1b[${this.#drawn.length - 1}A`;
    this.#write(out);
  }
}

/** Wrap terminal text without counting CSI styling sequences as cells. */
function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row = "";
    let cells = 0;
    for (let index = 0; index < line.length;) {
      if (line.startsWith("\x1b[", index)) {
        const end = line.slice(index + 2).search(/[@-~]/);
        if (end >= 0) {
          const sequenceEnd = index + end + 3;
          row += line.slice(index, sequenceEnd);
          index = sequenceEnd;
          continue;
        }
      }
      if (cells === width) {
        rows.push(row);
        row = "";
        cells = 0;
      }
      row += line[index] ?? "";
      cells++;
      index++;
    }
    rows.push(row);
  }
  return rows;
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
