import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../../tools/edit.ts";
import { isCrlf, withEndings } from "../../tools/eol.ts";
import { readTool } from "../../tools/read.ts";
import { tracker } from "../../tools/tracker.ts";
import { writeTool } from "../../tools/write.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-eol-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = { signal: new AbortController().signal, cwd: dir };

describe("Windows line endings (CRLF)", () => {
  test("which files are CRLF; text given the file's endings", () => {
    expect(isCrlf("a\r\nb\r\n")).toBe(true);
    expect(isCrlf("a\nb\n")).toBe(false);
    expect(isCrlf("one line")).toBe(false);
    expect(withEndings("x\ny\n", true)).toBe("x\r\ny\r\n");
    expect(withEndings("x\r\ny\n", true)).toBe("x\r\ny\r\n");
    expect(withEndings("x\ny", false)).toBe("x\ny");
  });

  test("read shows no \\r; edit finds the model's \\n text and writes \\r\\n; write keeps a CRLF file CRLF", async () => {
    tracker.reset();
    writeFileSync(join(dir, "win.ts"), "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
    const read = await readTool.run({ path: "win.ts" }, ctx);
    expect(read).not.toContain("\r");
    expect(read).toContain("2: const b = 2;");
    const edited = await editTool.run({ path: "win.ts", edits: [{ old: "const a = 1;\nconst b = 2;", new: "const a = 10;\nconst b = 20;\nconst bb = 21;" }] }, ctx);
    expect(edited).toStartWith("edited win.ts: 1 edit(s) applied");
    expect(edited).not.toContain("\r");
    expect(readFileSync(join(dir, "win.ts"), "utf8")).toBe("const a = 10;\r\nconst b = 20;\r\nconst bb = 21;\r\nconst c = 3;\r\n");
    expect(await writeTool.run({ path: "win.ts", content: "x\ny\n" }, ctx)).toStartWith("wrote 2 lines");
    expect(readFileSync(join(dir, "win.ts"), "utf8")).toBe("x\r\ny\r\n");
    await writeTool.run({ path: "new.ts", content: "fresh\n" }, ctx); // a new file: as given
    expect(readFileSync(join(dir, "new.ts"), "utf8")).toBe("fresh\n");
  });
});
