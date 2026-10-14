// What goes above the live region, in the order it happened: every finished block is printed into
// the terminal's own scrollback, so it scrolls like any other program's output. One block at a time
// is still open (the thinking or the answer being streamed); it is printed when it closes, or bit
// by bit when it grows taller than the region.

import type { Renderer, RenderState } from "./render.ts";
import { formatBlock, splitStable } from "./view.ts";
import type { BlockKind, OpenBlock } from "./view.ts";

export interface ScrollbackOptions {
  renderer: Renderer;
  /** The live region as it is now: the renderer repaints it right under what is printed. */
  state: () => RenderState;
  /** The transcript's columns (the window's, less the side column's), when known. */
  columns: () => number | undefined;
}

export class Scrollback {
  #renderer: Renderer;
  #state: () => RenderState;
  #columns: () => number | undefined;
  #open: OpenBlock | undefined;
  #printedAny = false; // something is printed already: every later block gets a blank row above
  #held: Array<() => void> | undefined; // the terminal is lent to the user's shell: prints wait here

  constructor(opts: ScrollbackOptions) {
    this.#renderer = opts.renderer;
    this.#state = opts.state;
    this.#columns = opts.columns;
  }

  /** The block being streamed, if any. */
  get open(): OpenBlock | undefined {
    return this.#open;
  }

  get printedAny(): boolean {
    return this.#printedAny;
  }

  /** Columns a printed row may take: the renderer keeps a margin on each side. */
  get width(): number {
    return (this.#columns() ?? 80) - 2;
  }

  /** Sends one finished piece to the scrollback. `gap` defaults to the usual blank row between
   *  blocks; `render` draws it again at another width (a resize). */
  print(kind: BlockKind, text: string, gap = this.#printedAny, key?: string, render?: (width: number) => string): void {
    if (text === "") return;
    if (this.#held) {
      this.#held.push(() => this.print(kind, text, gap, key, render));
      return;
    }
    this.#renderer.update(this.#state());
    const source = render && ((w: number): string => (gap ? `\n${render(w)}` : render(w)));
    this.#renderer.printAbove(gap ? `\n${text}` : text, key, source);
    this.#printedAny = true;
  }

  /** Adds streamed text to the open block; another kind of text closes it first. */
  append(kind: "thinking" | "assistant", delta: string): void {
    if (this.#open !== undefined && this.#open.kind !== kind) this.closeBlock();
    // Whitespace between two blocks must not open a block of its own.
    if (this.#open === undefined && delta.trim() === "") return;
    const open = (this.#open ??= { kind: kind, text: "", gap: this.#printedAny });
    open.text += delta;
    this.#spill();
  }

  /** Prints what is left of the open block and forgets it. */
  closeBlock(): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const text = formatBlock(open.kind, open.text, this.width);
    if (text !== "") this.print(open.kind, text, open.gap, undefined, (w) => formatBlock(open.kind, open.text, w));
  }

  /** The screen was wiped: the next block needs no blank row above it. */
  cleared(): void {
    this.#printedAny = false;
  }

  /** The terminal goes to the user's shell: from now on, prints wait. */
  hold(): void {
    this.#held = [];
  }

  /** Something to do once the terminal is back (prints, a panel to rewrite); false: do it now. */
  later(action: () => void): boolean {
    if (this.#held === undefined) return false;
    this.#held.push(action);
    return true;
  }

  /** The terminal is back: what waited is printed, in order. */
  release(): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const action of held) action();
  }

  get held(): boolean {
    return this.#held !== undefined;
  }

  /** Streaming text taller than the region: its stable head moves to the scrollback, in order. */
  #spill(): void {
    const open = this.#open;
    if (open === undefined) return;
    const split = splitStable(open.text, this.#columns());
    if (split === undefined) return;
    const chunk = formatBlock(open.kind, split.commit, this.width);
    const gap = open.gap;
    this.#open = { kind: open.kind, text: split.rest, gap: split.gap };
    if (chunk !== "") this.print(open.kind, chunk, gap, undefined, (w) => formatBlock(open.kind, split.commit, w));
  }
}
