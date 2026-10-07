import { expect, test, describe } from "bun:test";
import { Editor } from "./editor.ts";
import type { Key } from "../tui/term.ts";

function key(name: Key["name"], extra: Partial<Key> = {}): Key {
  return { name: name, ...extra };
}

function typed(editor: Editor, text: string): void {
  for (const ch of text) editor.handle(key("char", { char: ch }));
}

describe("tui editor", () => {
  test("1. typing, cursor position and backspace", () => {
    const editor = new Editor();
    typed(editor, "hello");
    expect(editor.text).toBe("hello");
    expect(editor.cursor).toBe(5);
    editor.handle(key("backspace"));
    expect(editor.text).toBe("hell");
    expect(editor.cursor).toBe(4);
    editor.handle(key("backspace"));
    editor.handle(key("backspace"));
    editor.handle(key("backspace"));
    editor.handle(key("backspace"));
    expect(editor.text).toBe("");
    expect(editor.handle(key("backspace"))).toBe("none");
  });

  test("2. insert happens at the cursor, not at the end", () => {
    const editor = new Editor();
    typed(editor, "hello");
    editor.handle(key("left"));
    editor.handle(key("left"));
    editor.insert("XY");
    expect(editor.text).toBe("helXYlo");
    expect(editor.cursor).toBe(5);
  });

  test("3. enter submits, shift-enter makes a line, empty enter does nothing", () => {
    const editor = new Editor();
    expect(editor.handle(key("enter"))).toBe("none");
    typed(editor, "do it");
    expect(editor.handle(key("enter"))).toBe("submit");
    editor.clear();
    expect(editor.empty).toBe(true);
    editor.handle(key("shift-enter"));
    editor.handle(key("shift-enter"));
    typed(editor, "line3");
    expect(editor.text).toBe("\n\nline3");
    expect(editor.lines).toHaveLength(3);
  });

  test("4. pasting is one edit, CRLF becomes LF", () => {
    const editor = new Editor();
    typed(editor, "start:");
    editor.handle(key("paste", { char: "one\r\ntwo\rthree" }));
    expect(editor.text).toBe("start:one\ntwo\nthree");
    expect(editor.cursor).toBe(editor.text.length);
  });

  test("5. up/down move between lines and keep the column", () => {
    const editor = new Editor();
    editor.setText("first line\nsecond line\nthird");
    editor.handle(key("end"));
    editor.handle(key("up"));
    expect(editor.cursor).toBe(editor.text.indexOf("second") + 5);
    editor.handle(key("up"));
    expect(editor.cursor).toBe(5);
    // Clamped at the edges.
    editor.handle(key("up"));
    expect(editor.cursor).toBe(5);
    editor.handle(key("down"));
    expect(editor.cursor).toBe(editor.text.indexOf("second") + 5);
    editor.handle(key("down"));
    editor.handle(key("down"));
    expect(editor.cursor).toBe(editor.text.length);
  });

  test("6. home, end and ctrl-a/ctrl-e work per line", () => {
    const editor = new Editor();
    editor.setText("alpha\nbravo");
    editor.handle(key("down"));
    expect(editor.cursor).toBe(editor.text.length);
    editor.handle(key("home"));
    expect(editor.cursor).toBe(editor.text.indexOf("bravo"));
    editor.handle(key("ctrl-e"));
    expect(editor.cursor).toBe(editor.text.length);
    editor.handle(key("ctrl-a"));
    expect(editor.cursor).toBe(editor.text.indexOf("bravo"));
  });

  test("7. ctrl-k kills to end of line, ctrl-u kills to start", () => {
    const editor = new Editor();
    // Both stop at the line boundary, not the buffer boundary.
    editor.setText("keep this\ndrop this"); // cursor at the end of line 2
    editor.handle(key("ctrl-u"));
    expect(editor.text).toBe("keep this\n");
    editor.setText("keep this\ndrop this", 12); // inside "dr|op this"
    editor.handle(key("ctrl-k")); // kills "op this", the first line survives
    expect(editor.text).toBe("keep this\ndr");
    editor.setText("keep this\ndrop this", 12);
    editor.handle(key("ctrl-u")); // kills "dr", the first line survives
    expect(editor.text).toBe("keep this\ndrop this".slice(0, 10) + "op this");
    editor.setText("keep this");
    editor.handle(key("end"));
    editor.handle(key("ctrl-u"));
    expect(editor.text).toBe("");
  });

  test("8. ctrl-w deletes the previous word", () => {
    const editor = new Editor();
    typed(editor, "one two three");
    editor.handle(key("ctrl-w"));
    expect(editor.text).toBe("one two ");
    editor.handle(key("ctrl-w"));
    expect(editor.text).toBe("one ");
  });

  test("9. word movement with ctrl or alt, character movement without", () => {
    const editor = new Editor();
    editor.setText("alpha beta gamma");
    expect(editor.handle(key("left"))).toBe("changed");
    expect(editor.cursor).toBe(15);
    // "alpha beta gamma": g at 11, b at 6. From inside gamma, each press goes one word back.
    editor.handle(key("left", { ctrl: true }));
    expect(editor.cursor).toBe(11);
    editor.handle(key("left", { ctrl: true }));
    expect(editor.cursor).toBe(6);
    editor.handle(key("left", { alt: true }));
    expect(editor.cursor).toBe(0);
    editor.handle(key("right", { ctrl: true }));
    expect(editor.cursor).toBe(5);
    expect(editor.text.slice(0, editor.cursor)).toBe("alpha");
    // At an edge it stops rather than wrapping.
    editor.setText("word", 0);
    editor.handle(key("left", { ctrl: true }));
    expect(editor.cursor).toBe(0);
    editor.setText("word", 4);
    editor.handle(key("right", { ctrl: true }));
    expect(editor.cursor).toBe(4);
  });

  test("10. history on ctrl-p/ctrl-n, and the live buffer comes back", () => {
    const editor = new Editor();
    editor.remember("first ask");
    editor.remember("second ask");
    typed(editor, "draft");
    expect(editor.handle(key("ctrl-p"))).toBe("history-prev");
    expect(editor.text).toBe("second ask");
    editor.handle(key("ctrl-p"));
    expect(editor.text).toBe("first ask");
    editor.handle(key("ctrl-p"));
    expect(editor.text).toBe("first ask"); // clamped
    editor.handle(key("ctrl-n"));
    expect(editor.text).toBe("second ask");
    editor.handle(key("ctrl-n"));
    expect(editor.text).toBe("draft"); // back to the buffer that was being typed
    expect(editor.cursor).toBe(editor.text.length);
  });

  test("11. history ignores blanks and repeats, and is capped", () => {
    const editor = new Editor({ maxHistory: 2 });
    editor.remember("a");
    editor.remember("a");
    editor.remember("  ");
    editor.remember("b");
    editor.remember("c");
    expect(editor.handle(key("ctrl-p"))).toBe("history-prev");
    expect(editor.text).toBe("c");
    editor.handle(key("ctrl-p"));
    expect(editor.text).toBe("b");
    editor.handle(key("ctrl-p"));
    expect(editor.text).toBe("b");
  });

  test("12. alt+up is reported to the TUI, which owns that binding", () => {
    const editor = new Editor({ history: ["older"] });
    typed(editor, "draft");
    expect(editor.handle(key("up", { alt: true }))).toBe("alt-up");
    expect(editor.handle(key("down", { alt: true }))).toBe("alt-down");
    // History belongs to ctrl-p/ctrl-n, so the two bindings never fight.
    expect(editor.text).toBe("draft");
  });

  test("13. alt+characters are ignored, so shortcuts do not land in the buffer", () => {
    const editor = new Editor();
    editor.handle(key("char", { char: "b", alt: true }));
    expect(editor.text).toBe("");
    expect(editor.handle(key("char", { char: "b", alt: true }))).toBe("none");
  });

  test("14. delete removes forward, and a multibyte character counts once", () => {
    const editor = new Editor();
    typed(editor, "a→b");
    editor.handle(key("home"));
    editor.handle(key("delete"));
    expect(editor.text).toBe("→b"); // the cursor stayed put
    editor.handle(key("right"));
    editor.handle(key("backspace"));
    expect(editor.text).toBe("b");
  });

  test("15. view() reports the cursor inside a wrapped buffer", () => {
    const editor = new Editor();
    editor.setText("abcdefghij", 5);
    const view = editor.view((line) => (line.length <= 4 ? [line] : line.match(/.{1,4}/g) ?? [line]));
    expect(view.lines).toEqual(["abcd", "efgh", "ij"]);
    expect(view.row).toBe(1);
    expect(view.col).toBe(1);
  });
});