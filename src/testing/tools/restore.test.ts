import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Message } from "../../types.ts";
import { restoreTracker } from "../../tools/restore.ts";
import { checkRead, tracker } from "../../tools/tracker.ts";
import { join } from "node:path";

const DIR = `${process.cwd()}/.tmp-restore-test-${process.pid}`;
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => {
  tracker.reset(); // a fresh process: nothing read yet
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

/** One assistant call and its tool result, as a session stores them. */
function call(id: string, name: string, args: object, result: string): Message[] {
  return [
    { id: `a${id}`, role: "assistant", content: "", toolCalls: [{ id, name, args }] },
    { id: `t${id}`, role: "tool", toolCallId: id, content: result },
  ];
}

describe("restoring read-before-change on resume", () => {
  test("files still exactly as the model last saw them need no fresh read; changed ones still do", async () => {
    writeFileSync(join(DIR, "written.ts"), "const a = 1;\n");
    writeFileSync(join(DIR, "edited.ts"), "let x = 2;\nlet y = 3;\n");
    writeFileSync(join(DIR, "changed.ts"), "someone else's version\n");
    writeFileSync(join(DIR, "read.ts"), "line one\n\nline three\n");
    writeFileSync(join(DIR, "partial.ts"), "a\nb\nc\n");
    const history = [
      ...call("1", "write", { path: "written.ts", content: "const a = 1;\n" }, "wrote 1 lines (13 chars) to written.ts"),
      ...call("2", "write", { path: "edited.ts", content: "let x = 1;\nlet y = 3;\n" }, "wrote 2 lines"),
      ...call("3", "edit", { path: "edited.ts", edits: [{ old: "x = 1", new: "x = 2" }] }, "edited edited.ts: 1 edit(s) applied"),
      ...call("4", "write", { path: "changed.ts", content: "the model's version\n" }, "wrote 1 lines"),
      ...call("5", "read", { path: "read.ts" }, "1: line one\n2: \n3: line three"),
      ...call("6", "read", { path: "partial.ts", limit: 1 }, "1: a\n[lines 1-1 of 3; continue with offset=2]"),
      ...call("7", "write", { path: "gone.ts", content: "x" }, "wrote 1 lines"),
    ];
    expect(await restoreTracker(history, DIR)).toBe(3);
    expect(await checkRead(join(DIR, "written.ts"))).toBeNull();
    expect(await checkRead(join(DIR, "edited.ts"))).toBeNull(); // the write, then its edit replayed
    expect(await checkRead(join(DIR, "read.ts"))).toBeNull(); // empty lines and the final newline survive
    expect(await checkRead(join(DIR, "changed.ts"))).toContain("read first"); // changed since: read again
    expect(await checkRead(join(DIR, "partial.ts"))).toContain("read first"); // only part of it was seen
  });

  test("a failed write or edit teaches nothing; an edit on an unknown file leaves it unknown", async () => {
    writeFileSync(join(DIR, "a.ts"), "new\n");
    writeFileSync(join(DIR, "b.ts"), "b2\n");
    const history = [
      ...call("1", "write", { path: "a.ts", content: "new\n" }, "ERROR: you must read this file before changing it"),
      ...call("2", "edit", { path: "b.ts", edits: [{ old: "b1", new: "b2" }] }, "edited b.ts: 1 edit(s) applied"),
    ];
    expect(await restoreTracker(history, DIR)).toBe(0);
    expect(await checkRead(join(DIR, "a.ts"))).toContain("read first");
    expect(await checkRead(join(DIR, "b.ts"))).toContain("read first");
  });
});
