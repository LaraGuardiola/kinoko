// Multiline line editor. Pure state plus a render function, so it can be unit tested without a
// terminal: the TUI feeds it keys and draws whatever `render()` returns.

import type { Key } from "./term.ts";

export type EditorAction =
  | "none"
  | "changed" // text or cursor moved
  | "submit" // Enter on a non-empty buffer
  | "newline" // Shift+Enter
  | "history-prev"
  | "history-next"
  | "alt-up" // left for the TUI: "pull the queued message back" (docs/interruption.md)
  | "alt-down";

export interface EditorView {
  /** One entry per visible row, already wrapped by the caller. */
  lines: string[];
  /** Cursor position inside `lines`. */
  row: number;
  col: number;
}

export interface EditorOptions {
  history?: string[];
  maxHistory?: number;
}

const DEFAULT_MAX_HISTORY = 200;

/** Length of the first match, or 0. `match()` returns an array: `.length` would be 1. */
function matchLength(text: string, re: RegExp): number {
  return text.match(re)?.[0]?.length ?? 0;
}

function firstChar(text: string): string {
  return [...text][0] ?? "";
}

function lastChar(text: string): string {
  return [...text].at(-1) ?? "";
}

export class Editor {
  #text = "";
  #cursor = 0; // character offset into #text
  #history: string[];
  #maxHistory: number;
  #saved = ""; // the in-progress line while browsing history
  #index = 0; // #history.length means "the live buffer"

  constructor(opts: EditorOptions = {}) {
    this.#history = opts.history ?? [];
    this.#maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.#index = this.#history.length;
  }

  get text(): string {
    return this.#text;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get lines(): string[] {
    return this.#text.split("\n");
  }

  /** True when there is nothing typed (submit does nothing). */
  get empty(): boolean {
    return this.#text.trim() === "";
  }

  /** Inserts text as one edit: used for typing and for pasted payloads. */
  insert(chunk: string): EditorAction {
    const clean = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.#text = this.#text.slice(0, this.#cursor) + clean + this.#text.slice(this.#cursor);
    this.#cursor += clean.length;
    return "changed";
  }

  /** Records a submitted line so Up can recall it later. */
  remember(line: string): void {
    const value = line.trim();
    if (value === "") return;
    if (this.#history.at(-1) === value) {
      this.#resetIndex();
      return;
    }
    this.#history.push(value);
    if (this.#history.length > this.#maxHistory) this.#history.shift();
    this.#resetIndex();
  }

  setText(text: string, cursor = text.length): void {
    this.#text = text;
    this.#cursor = Math.max(0, Math.min(cursor, text.length));
  }

  clear(): void {
    this.#text = "";
    this.#cursor = 0;
    this.#resetIndex();
  }

  /** Handles one key. Unknown keys are ignored rather than inserted. */
  handle(key: Key): EditorAction {
    switch (key.name) {
      case "char":
        if (key.alt) return "none";
        return this.insert(key.char ?? "");
      case "paste":
        return this.insert(key.char ?? "");
      case "enter":
        if (key.alt || key.ctrl) return this.#newline();
        return this.empty ? "none" : "submit";
      case "shift-enter":
        return this.#newline();
      case "backspace":
        return this.#backspace();
      case "delete":
        return this.#delete();
      case "left":
        this.#cursor = this.#moveWord(-1, key.ctrl === true || key.alt === true);
        return "changed";
      case "right":
        this.#cursor = this.#moveWord(1, key.ctrl === true || key.alt === true);
        return "changed";
      case "up":
        if (key.alt) return "alt-up";
        this.#cursor = this.#moveLine(-1);
        return "changed";
      case "down":
        if (key.alt) return "alt-down";
        this.#cursor = this.#moveLine(1);
        return "changed";
      case "home":
      case "ctrl-a":
        this.#cursor = this.#lineStart(this.#cursor);
        return "changed";
      case "end":
      case "ctrl-e":
        this.#cursor = this.#lineEnd(this.#cursor);
        return "changed";
      case "ctrl-u": {
        const start = this.#lineStart(this.#cursor);
        this.#text = this.#text.slice(0, start) + this.#text.slice(this.#cursor);
        this.#cursor = start;
        return "changed";
      }
      case "ctrl-k": {
        // Kill from the cursor to the end of the line, leaving the rest of the buffer alone.
        const end = this.#lineEnd(this.#cursor);
        this.#text = this.#text.slice(0, this.#cursor) + this.#text.slice(end);
        return "changed";
      }
      case "ctrl-w":
        this.#cursor = this.#deleteWordBack();
        return "changed";
      case "ctrl-p":
        return this.#historyStep(-1);
      case "ctrl-n":
        return this.#historyStep(1);
      default:
        return "none";
    }
  }

  /** Where the cursor sits in a wrapped view of the editor. */
  view(wrap: (line: string) => string[]): EditorView {
    const before = this.#text.slice(0, this.#cursor);
    const rows: string[] = [];
    let row = 0;
    for (const line of this.lines) {
      for (const piece of wrap(line)) rows.push(piece);
    }
    // Recompute the row by wrapping everything up to the cursor only.
    const lines = before.split("\n");
    for (let i = 0; i < lines.length - 1; i++) row += wrap(lines[i] ?? "").length;
    const last = lines.at(-1) ?? "";
    const wrapped = wrap(last);
    row += Math.max(0, wrapped.length - 1); // the cursor may be inside the last logical line
    return { lines: rows, row: row, col: (wrapped.at(-1) ?? "").length };
  }

  #newline(): EditorAction {
    return this.insert("\n");
  }

  #backspace(): EditorAction {
    if (this.#cursor === 0) return "none";
    // Delete a whole grapheme, so an emoji or an arrow key costs one press.
    const prev = lastChar(this.#text.slice(0, this.#cursor));
    this.#text = this.#text.slice(0, this.#cursor - prev.length) + this.#text.slice(this.#cursor);
    this.#cursor -= prev.length;
    return "changed";
  }

  #delete(): EditorAction {
    if (this.#cursor >= this.#text.length) return "none";
    const next = firstChar(this.#text.slice(this.#cursor));
    this.#text = this.#text.slice(0, this.#cursor) + this.#text.slice(this.#cursor + next.length);
    return "changed";
  }

  #deleteWordBack(): number {
    const head = this.#text.slice(0, this.#cursor).replace(/\s+$/, "");
    const trimmed = head.replace(/\S+$/, "");
    this.#text = trimmed + this.#text.slice(this.#cursor);
    return trimmed.length;
  }

  #lineStart(at: number): number {
    return this.#text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  }

  #lineEnd(at: number): number {
    const next = this.#text.indexOf("\n", at);
    return next < 0 ? this.#text.length : next;
  }

  #moveLine(direction: -1 | 1): number {
    const start = this.#lineStart(this.#cursor);
    const end = this.#lineEnd(this.#cursor);
    const column = this.#cursor - start;
    if (direction === -1) {
      if (start === 0) return this.#cursor;
      const prevStart = this.#lineStart(start - 1);
      const prevLength = start - 1 - prevStart;
      return prevStart + Math.min(column, prevLength);
    }
    if (end >= this.#text.length) return this.#cursor;
    const nextStart = end + 1;
    const nextEnd = this.#lineEnd(nextStart);
    return nextStart + Math.min(column, nextEnd - nextStart);
  }

  #moveWord(direction: -1 | 1, word: boolean): number {
    if (!word) return Math.max(0, Math.min(this.#text.length, this.#cursor + direction));
    if (direction === 1) {
      const rest = this.#text.slice(this.#cursor);
      const lead = rest.length - rest.trimStart().length;
      const at = lead + matchLength(rest.trimStart(), /^\S+/);
      return Math.min(this.#text.length, this.#cursor + (at === 0 ? 1 : at));
    }
    const head = this.#text.slice(0, this.#cursor);
    const trimmed = head.trimEnd();
    const at = trimmed.length - matchLength(trimmed, /\S+$/);
    return Math.max(0, at);
  }

  #historyStep(direction: -1 | 1): EditorAction {
    if (this.#history.length === 0) return "none";
    if (this.#index === this.#history.length) this.#saved = this.#text;
    const next = Math.max(0, Math.min(this.#history.length, this.#index + direction));
    if (next === this.#index) return "none";
    this.#index = next;
    this.#text = next === this.#history.length ? this.#saved : (this.#history[next] ?? "");
    this.#cursor = this.#text.length;
    return direction === -1 ? "history-prev" : "history-next";
  }

  #resetIndex(): void {
    this.#index = this.#history.length;
    this.#saved = "";
  }
}