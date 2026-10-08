import { expect, test, describe } from "bun:test";
import { actionFor } from "../../tui/keys.ts";
import type { Key } from "../../tui/term.ts";

function key(name: Key["name"], extra: Partial<Key> = {}): Key {
  return { name: name, ...extra };
}

const idle = { running: false, editorEmpty: true };
const running = { running: true, editorEmpty: true };
const typing = { running: false, editorEmpty: false };

describe("tui key bindings (docs/interruption.md)", () => {
  test("1. Enter sends a prompt when idle and steers when running", () => {
    // The editor reports the submit; #submit decides steer vs prompt.
    expect(actionFor(key("enter"), idle)).toBe("editor");
    expect(actionFor(key("enter"), running)).toBe("editor");
  });

  test("2. Alt+Enter is a follow-up while running and a prompt when idle", () => {
    expect(actionFor(key("enter", { alt: true }), running)).toBe("follow-up");
    expect(actionFor(key("enter", { alt: true }), idle)).toBe("submit");
  });

  test("2b. Shift+Enter goes to the editor, which inserts a newline, idle or running", () => {
    expect(actionFor(key("shift-enter"), idle)).toBe("editor");
    expect(actionFor(key("shift-enter"), running)).toBe("editor");
  });

  test("3. Esc aborts while running and does nothing when idle", () => {
    expect(actionFor(key("escape"), running)).toBe("abort");
    expect(actionFor(key("escape"), idle)).toBe("none");
    expect(actionFor(key("escape"), typing)).toBe("none");
  });

  test("4. Ctrl-C is the ladder: abort, clear, quit", () => {
    expect(actionFor(key("ctrl-c"), running)).toBe("abort");
    expect(actionFor(key("ctrl-c"), typing)).toBe("clear-editor");
    expect(actionFor(key("ctrl-c"), idle)).toBe("quit");
    expect(actionFor(key("ctrl-c"), { running: true, editorEmpty: false })).toBe("abort");
  });

  test("5. Ctrl-D quits only on an empty editor", () => {
    expect(actionFor(key("ctrl-d"), idle)).toBe("quit");
    expect(actionFor(key("ctrl-d"), typing)).toBe("none");
  });

  test("6. Alt+Up pulls the queued message, plain Up is the editor's", () => {
    expect(actionFor(key("up", { alt: true }), running)).toBe("pull-queued");
    expect(actionFor(key("up"), idle)).toBe("editor");
  });

  test("7. Ctrl-T toggles tool output everywhere", () => {
    expect(actionFor(key("ctrl-t"), idle)).toBe("toggle-tools");
    expect(actionFor(key("ctrl-t"), running)).toBe("toggle-tools");
  });

  test("8. everything else goes to the editor", () => {
    for (const name of ["char", "paste", "backspace", "delete", "left", "right", "down", "home", "end", "ctrl-a", "ctrl-e", "ctrl-k", "ctrl-u", "ctrl-w", "ctrl-p", "ctrl-n", "ctrl-o", "tab", "pageup", "pagedown"] as const) {
      expect(actionFor(key(name), idle)).toBe("editor");
    }
  });
});