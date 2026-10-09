// Raw terminal input: a pure key parser plus the thin layer that feeds it real stdin.
//
// No alternate screen anywhere: the native scrollback stays, and the live region is a few lines we
// repaint at the bottom (see render.ts). Nothing here blocks the event loop.

export type KeyName =
  | "char"
  | "paste"
  | "enter"
  | "shift-enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-a"
  | "ctrl-e"
  | "ctrl-k"
  | "ctrl-u"
  | "ctrl-w"
  | "ctrl-p"
  | "ctrl-n"
  | "ctrl-l"
  | "ctrl-t" // expand/collapse tool output
  | "ctrl-o" // newline while idle (Alt+Enter is taken by follow-up)
  | "ctrl-v" // paste an image from the clipboard
  | "size-report" // the terminal answering SIZE_QUERY: its window or the screen, in pixels
  | "unknown";

export interface Key {
  name: KeyName;
  char?: string; // for "char" and "paste"
  size?: { of: "window" | "screen"; width: number; height: number }; // for "size-report"
  alt?: boolean;
  ctrl?: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** ESC [ ... final-byte sequences we care about, mapped by their final byte. */
const CSI: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  "1~": "home",
  "3~": "delete",
  "4~": "end",
  "5~": "pageup",
  "6~": "pagedown",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OH: "home",
  OF: "end",
};

const CTRL: Record<string, KeyName> = {
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x01": "ctrl-a",
  "\x05": "ctrl-e",
  "\x0b": "ctrl-k",
  "\x15": "ctrl-u",
  "\x17": "ctrl-w",
  "\x10": "ctrl-p",
  "\x0e": "ctrl-n",
  "\x0c": "ctrl-l",
  "\x14": "ctrl-t",
  "\x0f": "ctrl-o",
  "\x16": "ctrl-v",
  "\x7f": "backspace",
  "\x08": "backspace",
  "\r": "enter",
  // Ctrl+J: the newline key every terminal can send, kitty protocol or not.
  "\n": "shift-enter",
  "\t": "tab",
};

/**
 * Incremental parser: bytes can arrive in any chunking, and a paste payload may span chunks.
 * A lone ESC at the end of a chunk is reported as "escape" (a real terminal sends Alt+<key> and
 * arrow sequences as one burst, so this is safe in practice).
 */
export class KeyParser {
  #pending = ""; // incomplete escape sequence
  #paste = false; // inside a bracketed paste
  #pasteBuf = "";

  push(chunk: string): Key[] {
    const keys: Key[] = [];
    let text = this.#pending + chunk;
    this.#pending = "";
    let i = 0;

    while (i < text.length) {
      if (this.#paste) {
        const end = text.indexOf(PASTE_END, i);
        if (end < 0) {
          // Hold back a half-arrived end marker so it is not pasted as text.
          const hold = partialSuffix(text, PASTE_END);
          this.#pasteBuf += text.slice(i, text.length - hold);
          this.#pending = text.slice(text.length - hold);
          return keys;
        }
        this.#pasteBuf += text.slice(i, end);
        keys.push({ name: "paste", char: this.#pasteBuf });
        this.#pasteBuf = "";
        this.#paste = false;
        i = end + PASTE_END.length;
        continue;
      }

      const rest = text.slice(i);
      if (rest.startsWith(PASTE_START)) {
        this.#paste = true;
        i += PASTE_START.length;
        continue;
      }

      if (rest.startsWith("\x1b[")) {
        const seq = csi(rest);
        if (seq === null) {
          if (rest.length < 32) {
            // Maybe the rest of the sequence has not arrived yet.
            this.#pending = rest;
            return keys;
          }
          i++;
          continue;
        }
        keys.push(seq.key);
        i += seq.length;
        continue;
      }

      if (rest.startsWith("\x1bO") && rest.length >= 3) {
        // \x1bOM is the keypad Enter in application keypad mode.
        const name = rest[2] === "M" ? "enter" : CSI[rest[2] ?? ""];
        keys.push(name === undefined ? { name: "unknown" } : { name: name });
        i += 3;
        continue;
      }

      if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) {
        // ESC+Enter is what terminals are set up to send for Shift+Enter (Zed, VS Code, iTerm with
        // Claude Code's setup), so it is a newline, as in other TUIs. Alt+Enter sends the same bytes
        // in the legacy encoding; with the kitty protocol it arrives apart as CSI 13;3u.
        keys.push({ name: "shift-enter" });
        i += 2;
        continue;
      }

      if (rest.startsWith("\x1b[200~")) {
        i += PASTE_START.length;
        continue;
      }

      const ch = rest[0] ?? "";
      if (ch === "\x1b") {
        if (rest.length === 1) {
          // Either Esc on its own or the start of a sequence: hold it until the next chunk,
          // and let flush() turn it into a real Esc once the terminal stays quiet.
          this.#pending = rest;
          return keys;
        }
        if (rest[1] === "\x1b") {
          keys.push({ name: "escape" }); // two Esc presses in a row
          i += 1;
          continue;
        }
        // Alt + printable: \x1bx
        const alt = rest[1] ?? "";
        const known = CTRL[alt];
        keys.push(known === undefined ? { name: "char", char: alt, alt: true } : { name: known, alt: true });
        i += 2;
        continue;
      }

      const ctrlName = CTRL[ch];
      keys.push(ctrlName === undefined ? { name: "char", char: ch } : { name: ctrlName });
      i += 1;
    }
    return keys;
  }

  /**
   * Call once per frame. A held-back lone ESC becomes a real Esc here, so pressing it never waits
   * longer than one frame; anything else half-arrived is discarded.
   */
  flush(): Key[] {
    const held = this.#pending;
    this.#pending = "";
    return held === "\x1b" ? [{ name: "escape" }] : [];
  }

  /** True when a paste is still open (used on shutdown to restore the terminal). */
  get pasting(): boolean {
    return this.#paste;
  }
}

/** Length of the longest proper prefix of `marker` that is also a suffix of `s`. */
function partialSuffix(s: string, marker: string): number {
  for (let k = Math.min(marker.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/** Parses one CSI sequence starting at index 0 of `s`; null when it is still incomplete. */
function csi(s: string): null | { key: Key; length: number } {
  const body = s.slice(2);
  const finalAt = body.search(/[A-Za-z~]/);
  if (finalAt < 0) return null;
  const params = body.slice(0, finalAt);
  const final = body[finalAt] ?? "";
  const length = 2 + finalAt + 1;
  if (final === "u") return { key: kittyKey(params), length: length };
  if (final === "t") return { key: sizeReport(params), length: length };
  // Keypad sequences are numbered and end in `~`: \x1b[3~ is delete.
  if (final === "~") {
    const name = CSI[`${params}~`];
    return name === undefined ? { key: { name: "unknown" }, length: length } : { key: { name: name }, length: length };
  }
  const name = CSI[final];
  if (name === undefined) return { key: { name: "unknown" }, length: length };
  // Modified arrows: \x1b[1;5A is ctrl+up, \x1b[1;3A alt+up, \x1b[1;2A shift+up. Modifiers are
  // only reported when they are set, so a plain arrow stays a plain arrow.
  const modifier = params.split(";").at(-1);
  const key: Key = { name: name };
  if (modifier === "3") key.alt = true;
  if (modifier === "5") key.ctrl = true;
  return { key: key, length: length };
}

/**
 * Asks the terminal for its window and the screen, in pixels (XTWINOPS 14;2 and 15: foot, xterm,
 * kitty...). The answers come back on stdin as `CSI 4;h;w t` and `CSI 5;h;w t`; terminals that do
 * not know them stay silent.
 */
export const SIZE_QUERY = "\x1b[14;2t\x1b[15t";

function sizeReport(params: string): Key {
  const [kind, height, width] = params.split(";").map(Number);
  if ((kind !== 4 && kind !== 5) || !height || !width) return { name: "unknown" };
  return { name: "size-report", size: { of: kind === 4 ? "window" : "screen", width, height } };
}

/**
 * The kitty keyboard protocol (`CSI code ; modifiers u`), which Term turns on so Shift+Enter is
 * told apart from Enter. With it, Esc and Ctrl/Alt combinations arrive this way too.
 */
function kittyKey(params: string): Key {
  const [codeText = "", modText = "1"] = params.split(";");
  const code = keypadToMain(Number(codeText.split(":")[0]));
  const mods = Number(modText.split(":")[0]) - 1;
  const shift = (mods & 1) !== 0;
  const alt = (mods & 2) !== 0;
  const ctrl = (mods & 4) !== 0;
  if (code === 13) return shift || ctrl ? { name: "shift-enter" } : alt ? { name: "enter", alt: true } : { name: "enter" };
  if (code === 27) return { name: "escape" };
  if (code === 9) return { name: "tab" };
  if (code === 127 || code === 8) return { name: "backspace" };
  // Functional keys the protocol numbers in the private use area (F13+, media...) type nothing.
  if (!Number.isFinite(code) || code < 32 || (code >= 0xe000 && code <= 0xf8ff)) return { name: "unknown" };
  const char = String.fromCodePoint(code);
  if (ctrl) {
    const name = CTRL[String.fromCharCode(code & 0x1f)];
    return name === undefined ? { name: "unknown" } : alt ? { name: name, alt: true } : { name: name };
  }
  return alt ? { name: "char", char: char, alt: true } : { name: "char", char: shift ? char.toUpperCase() : char };
}

/** Kitty numbers keypad keys 57399 (KP_0) to 57416 (KP_Separator); each acts as its main-block twin. */
const KEYPAD = "0123456789./*-+\r=,";
function keypadToMain(code: number): number {
  const twin = KEYPAD[code - 57399];
  return twin === undefined ? code : twin.charCodeAt(0);
}

export interface TermHandlers {
  key: (key: Key) => void;
  resize: (cols: number, rows: number) => void;
}

/** Raw mode over stdin, plus the write side the renderer uses. Never blocks. */
export class Term {
  #parser = new KeyParser();
  #handlers: TermHandlers | undefined;
  #onData = (chunk: Buffer): void => {
    const text = this.#decoder.decode(chunk, { stream: true });
    for (const key of this.#parser.push(text)) this.#handlers?.key(key);
  };
  #onResize = (): void => {
    this.#handlers?.resize(this.cols, this.rows);
    this.write(SIZE_QUERY); // the window's share of the screen changed too
  };
  #decoder = new TextDecoder();

  get cols(): number {
    return process.stdout.columns ?? 80;
  }

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  /** Subscribes to keys and resizes. `start()` is separate so tests need no terminal. */
  on(handlers: TermHandlers): () => void {
    this.#handlers = handlers;
    return () => {
      this.#handlers = undefined;
    };
  }

  /** Drains a held-back Esc. Call from the render loop so Esc always responds within a frame. */
  pollKeys(): void {
    for (const key of this.#parser.flush()) this.#handlers?.key(key);
  }

  start(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", this.#onData);
    process.stdout.on("resize", this.#onResize);
    // Bracketed paste on; kitty keyboard protocol level 1 (terminals without it ignore the push).
    this.write(`\x1b[?2004h\x1b[>1u${SIZE_QUERY}`);
  }

  stop(): void {
    this.write("\x1b[<u\x1b[?2004l\x1b[?25h"); // keyboard protocol popped, paste off, cursor back
    process.stdout.off("resize", this.#onResize);
    process.stdin.off("data", this.#onData);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  write(text: string): void {
    process.stdout.write(text);
  }
}