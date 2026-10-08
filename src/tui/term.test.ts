import { expect, test, describe } from "bun:test";
import { KeyParser } from "./term.ts";
import type { Key, KeyName } from "./term.ts";

function parse(...chunks: string[]): Key[] {
  const parser = new KeyParser();
  const out: Key[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  return out;
}

function names(...chunks: string[]): KeyName[] {
  return parse(...chunks).map((k) => k.name);
}

describe("tui key parser", () => {
  test("1. plain characters, one key each", () => {
    expect(parse("hi")).toEqual([
      { name: "char", char: "h" },
      { name: "char", char: "i" },
    ]);
  });

  test("2. control keys", () => {
    expect(names("\r", "\t", "\x7f", "\x03", "\x04")).toEqual([
      "enter",
      "tab",
      "backspace",
      "ctrl-c",
      "ctrl-d",
    ]);
    expect(names("\x01", "\x05", "\x0b", "\x15", "\x17", "\x10", "\x0e")).toEqual([
      "ctrl-a",
      "ctrl-e",
      "ctrl-k",
      "ctrl-u",
      "ctrl-w",
      "ctrl-p",
      "ctrl-n",
    ]);
  });

  test("3. arrows, home, end, delete and page keys, in both CSI and SS3 form", () => {
    expect(names("\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(names("\x1bOA", "\x1bOB")).toEqual(["up", "down"]);
    expect(names("\x1b[H", "\x1b[F", "\x1b[3~")).toEqual(["home", "end", "delete"]);
    expect(names("\x1b[5~", "\x1b[6~")).toEqual(["pageup", "pagedown"]);
  });

  test("4. modified arrows keep their modifier", () => {
    expect(parse("\x1b[1;3A")).toEqual([{ name: "up", alt: true }]);
    expect(parse("\x1b[1;5D")).toEqual([{ name: "left", ctrl: true }]);
    expect(parse("\x1b[1;2A")).toEqual([{ name: "up" }]); // shift reports no modifier
  });

  test("5. a sequence split across chunks is still one key", () => {
    expect(names("\x1b[", "A")).toEqual(["up"]);
    expect(names("\x1b", "[3", "~")).toEqual(["delete"]);
    expect(parse("a\x1b[", "Bx")).toEqual([
      { name: "char", char: "a" },
      { name: "down" },
      { name: "char", char: "x" },
    ]);
  });

  test("6. legacy alt+enter stays alt+enter; ctrl+j is the newline key", () => {
    expect(parse("\x1b\r")).toEqual([{ name: "enter", alt: true }]);
    expect(names("\n")).toEqual(["shift-enter"]);
    expect(names("\r")).toEqual(["enter"]);
  });

  test("6b. kitty keyboard protocol: shift+enter, alt+enter, esc and ctrl/alt keys", () => {
    expect(names("\x1b[13;2u")).toEqual(["shift-enter"]);
    expect(names("\x1b[13;5u")).toEqual(["shift-enter"]);
    expect(parse("\x1b[13;3u")).toEqual([{ name: "enter", alt: true }]);
    expect(names("\x1b[13u")).toEqual(["enter"]);
    expect(names("\x1b[27u")).toEqual(["escape"]);
    expect(names("\x1b[99;5u")).toEqual(["ctrl-c"]);
    expect(names("\x1b[116;5u")).toEqual(["ctrl-t"]);
    expect(parse("\x1b[98;3u")).toEqual([{ name: "char", char: "b", alt: true }]);
  });

  test("7. alt+character, and a lone escape held back until the next flush", () => {
    expect(parse("\x1bb")).toEqual([{ name: "char", char: "b", alt: true }]);
    // A lone ESC waits, in case the rest of a sequence is still coming.
    const parser = new KeyParser();
    expect(parser.push("a\x1b")).toEqual([{ name: "char", char: "a" }]);
    expect(parser.flush()).toEqual([{ name: "escape" }]);
    expect(parser.flush()).toEqual([]);
    // The second Esc of a double press is also held back, same as a lone one.
    const twice = new KeyParser();
    expect(twice.push("\x1b\x1b")).toEqual([{ name: "escape" }]);
    expect(twice.flush()).toEqual([{ name: "escape" }]);
  });

  test("8. a paste arrives as one key, even split across chunks", () => {
    const pasted = parse("\x1b[200~hello\nworld\x1b[201~");
    expect(pasted).toEqual([{ name: "paste", char: "hello\nworld" }]);
    // The end marker itself arrives in two pieces.
    const split = parse("\x1b[200~hel", "lo\nwor", "ld\x1b[201", "~x");
    expect(split[0]).toEqual({ name: "paste", char: "hello\nworld" });
    expect(split[1]).toEqual({ name: "char", char: "x" });
  });

  test("9. paste state survives a chunk boundary and an unknown sequence is skipped", () => {
    const parser = new KeyParser();
    expect(parser.push("\x1b[200~abc").length).toBe(0);
    expect(parser.pasting).toBe(true);
    expect(parser.push("def\x1b[201~")).toEqual([{ name: "paste", char: "abcdef" }]);
    expect(parser.pasting).toBe(false);
    expect(names("\x1b[99~z")).toEqual(["unknown", "char"]); // numbered but unknown
    expect(names("\x1b[999z")).toEqual(["unknown"]); // one complete unknown sequence
  });

  test("10. utf-8 text is not mangled", () => {
    expect(parse("héllo→")).toEqual([
      { name: "char", char: "h" },
      { name: "char", char: "é" },
      { name: "char", char: "l" },
      { name: "char", char: "l" },
      { name: "char", char: "o" },
      { name: "char", char: "→" },
    ]);
  });
});