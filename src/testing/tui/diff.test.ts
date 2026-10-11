import { describe, expect, test } from "bun:test";
import { ADDED_BG, REMOVED_BG, diffLines, isDiff } from "../../tui/diff.ts";
import { SYNTAX } from "../../tui/highlight.ts";
import { renderMarkdown } from "../../tui/markdown.ts";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("diff blocks", () => {
  test("a diff or patch fence, or an unlabelled fence that plainly holds one", () => {
    expect(isDiff("diff", ["x"])).toBe(true);
    expect(isDiff("", ["", "diff --git a/x b/x"])).toBe(true);
    expect(isDiff("", ["--- a/x", "+++ b/x"])).toBe(true);
    expect(isDiff("", ["@@ -1 +1 @@"])).toBe(true);
    expect(isDiff("", ["- a list item", "- another"])).toBe(false);
    expect(isDiff("ts", ["--- a/x", "+++ b/x"])).toBe(false);
  });

  test("added and removed lines take a tinted row; file headers are not changes", () => {
    const out = diffLines(["--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " same", "-old line", "+new thing"]);
    expect(out.map((l) => l.bg)).toEqual([undefined, undefined, undefined, undefined, REMOVED_BG, ADDED_BG]);
    expect(out.map((l) => strip(l.text))).toEqual(["--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " same", "-old line", "+new thing"]);
    expect(out[0]?.text).not.toContain(SYNTAX.removed);
  });

  test("a changed line marks the words that changed; unrelated lines get no marks", () => {
    const [old, now] = diffLines(["-const timeout = 20_000;", "+const timeout = 8_000;"]);
    expect(old?.text).toContain(`${ESC}[48;2;122;46;58m2`); // "2" of 20_000 starts the mark
    expect(now?.text).toContain(`${ESC}[48;2;46;102;64m8`);
    const [a, b] = diffLines(["-alpha", "+zzzzzz"]);
    expect(a?.text).not.toContain("48;2;122;46;58");
    expect(b?.text).not.toContain("48;2;46;102;64");
  });

  test("the code is coloured in the language of the file the header names", () => {
    const out = diffLines(["--- a/src/x.ts", "+++ b/src/x.ts", "+const a = 1;"]);
    expect(out[2]?.text).toContain(SYNTAX.keyword); // `const` as TypeScript
    expect(diffLines(["+const a = 1;"])[0]?.text).not.toContain(SYNTAX.keyword); // no file named: plain green
  });

  test("in the transcript: a Diff panel whose changed rows keep their tint across a wrap", () => {
    const rows = renderMarkdown(["```diff", `+${"word ".repeat(12)}`, "```"].join("\n"), { width: 30 }).split("\n");
    expect(strip(rows[1] ?? "")).toContain("Diff");
    const tinted = rows.filter((row) => row.startsWith(ADDED_BG));
    expect(tinted.length).toBeGreaterThan(1);
  });
});
