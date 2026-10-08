import { expect, test, describe } from "bun:test";
import { formatBlock, liveRegion, splitStable, STREAM_ROWS, wrapAnsi } from "./view.ts";
import { toolBlock, toolFailed, toolSummary } from "./tools.ts";
import type { RegionInput } from "./view.ts";

const stripAnsi = (line: string): string => line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

function input(over: Partial<RegionInput> = {}): RegionInput {
  return {
    open: undefined,
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
    ...over,
  };
}

describe("live region", () => {
  test("idle: a blank row, the editor between two rules with the hint as placeholder, the status", () => {
    const region = liveRegion(input({ viewportRows: 10, viewportCols: 20 }));
    const plain = region.lines.map(stripAnsi);
    expect(plain).toHaveLength(5);
    expect(plain[0]).toBe("");
    expect(plain[1]).toBe("─".repeat(18));
    expect(plain[2]?.startsWith("> type a prompt")).toBe(true);
    expect(plain[3]).toBe("─".repeat(18));
    expect(plain[4]).toBe(" IDLE ");
    // The placeholder's first letter wears the block cursor.
    expect(region.lines[2]?.startsWith("> \x1b[7mt\x1b[0m")).toBe(true);
    expect(region.row).toBe(2);
  });

  test("the block cursor sits on the character under it, or past the end of the line", () => {
    const mid = liveRegion(input({ editorLines: ["abc"], editorEmpty: false, editorCol: 1 }));
    expect(mid.lines[2]).toBe("> a\x1b[7mb\x1b[0mc");
    const end = liveRegion(input({ editorLines: ["abc"], editorEmpty: false, editorCol: 3 }));
    expect(end.lines[2]).toBe("> abc\x1b[7m \x1b[0m");
  });

  test("the place line goes under the bottom rule, above the status", () => {
    const region = liveRegion(input({ place: "~/Projects/kinoko (master)" }));
    const plain = region.lines.map(stripAnsi);
    expect(plain.slice(-2)).toEqual(["~/Projects/kinoko (master)", " IDLE "]);
  });

  test("finished history is NOT part of the region any more (it lives in the scrollback)", () => {
    const region = liveRegion(input({ viewportRows: 10 }));
    expect(region.lines.join("\n")).not.toContain("answer");
    expect(Object.keys(region).toSorted()).toEqual(["col", "lines", "row"]);
  });

  test("the open block renders above the editor, the thinking style is dim italic", () => {
    const region = liveRegion(input({ open: { kind: "thinking", text: "reasoning", gap: false, inFence: false } }));
    expect(region.lines[0]).toBe("\x1b[2m\x1b[3mreasoning\x1b[0m");
    const answer = liveRegion(input({ open: { kind: "assistant", text: "answer", gap: false, inFence: false } }));
    expect(answer.lines[0]).toBe("answer");
  });

  test("only ONE block is ever open: thinking and answer are never in the region together", () => {
    const region = liveRegion(input({ open: { kind: "assistant", text: "answer", gap: false, inFence: false } }));
    expect(region.lines.filter((line) => stripAnsi(line) === "reasoning")).toHaveLength(0);
  });

  test("a gap puts a blank row before the open block", () => {
    const region = liveRegion(input({ open: { kind: "assistant", text: "x", gap: true, inFence: false } }));
    expect(region.lines.slice(0, 2)).toEqual(["", "x"]);
  });

  test("a short viewport keeps the tail of the open block with the editor pinned below it", () => {
    const region = liveRegion(
      input({
        open: { kind: "assistant", text: "one\ntwo\nthree\nfour", gap: false, inFence: false },
        editorLines: ["draft"],
        editorEmpty: false,
        editorCol: 5,
        viewportRows: 6,
      }),
    );
    expect(region.lines.map(stripAnsi).filter((line) => !line.startsWith("─"))).toEqual(["four", "", "> draft ", " IDLE "]);
    expect(region.row).toBe(3);
  });

  test("a tiny viewport drops the chrome but keeps the editor and the status", () => {
    const region = liveRegion(input({ editorLines: ["x"], editorEmpty: false, editorCol: 1, viewportRows: 3 }));
    expect(region.lines.map(stripAnsi)).toEqual(["> x ", " IDLE "]);
    expect(region.row).toBe(0);
  });

  test("the region never exceeds the viewport", () => {
    const text = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n");
    const region = liveRegion(
      input({ open: { kind: "assistant", text, gap: false, inFence: false }, queued: [{ kind: "steer", text: "later" }], viewportRows: 8 }),
    );
    expect(region.lines.length).toBeLessThanOrEqual(8);
  });

  test("clips styled rows before the terminal margin", () => {
    const region = liveRegion(
      input({ editorLines: ["abcdef"], editorEmpty: false, editorCol: 6, viewportRows: 3, viewportCols: 6 }),
    );
    expect(region.lines[0]).toBe("> a…\x1b[0m");
    expect(region.col).toBe(4);
  });

  test("long streaming rows wrap to the full width instead of ending in an ellipsis", () => {
    const region = liveRegion(
      input({
        open: { kind: "assistant", text: "x ".repeat(50), gap: false, inFence: false },
        editorEmpty: false,
        viewportRows: 20,
        viewportCols: 40,
      }),
    );
    for (const line of region.lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(38);
    expect(region.lines.some((line) => line.includes("…"))).toBe(false);
  });

  test("a running tool and queued messages sit between the block and the editor", () => {
    const region = liveRegion(
      input({
        tool: { name: "bash", args: "{}", output: "", aborted: false },
        queued: [{ kind: "followUp", text: "next" }],
        marker: "Interrupted",
      }),
    );
    const plain = region.lines.map(stripAnsi);
    expect(plain[0]).toBe("● bash {} …");
    expect(plain[1]).toBe("Interrupted");
    expect(plain[2]).toBe("[follow-up] next");
  });
});

describe("formatBlock", () => {
  test("user messages are light blue and keep the prompt mark on every row", () => {
    expect(formatBlock("user", "help me")).toBe("\x1b[38;5;159m> help me\x1b[0m");
    expect(formatBlock("user", "another\nmessage")).toBe(
      "\x1b[38;5;159m> another\x1b[0m\n\x1b[38;5;159m> message\x1b[0m",
    );
  });

  test("thinking is dim italic and answers go through markdown", () => {
    expect(formatBlock("thinking", "reasoning")).toBe("\x1b[2m\x1b[3mreasoning\x1b[0m");
    expect(formatBlock("assistant", "a **b**")).toBe("a \x1b[1mb\x1b[0m");
  });

  test("surrounding blank lines are trimmed, an empty block is empty", () => {
    expect(formatBlock("system", "\n\nhi\n\n")).toBe("hi");
    expect(formatBlock("assistant", "\n \n").trim()).toBe("");
  });

  test("a chunk that starts inside a fence stays code: nothing is inline-formatted", () => {
    expect(stripAnsi(formatBlock("assistant", "a = **b**", true))).toBe("a = **b**");
    expect(formatBlock("assistant", "a = **b**", false)).toContain("\x1b[1mb");
  });
});

const para = (n: number): string => `paragraph ${n}`;

describe("splitStable", () => {
  test("while everything fits nothing moves", () => {
    expect(splitStable("one\ntwo\nthree", 80)).toBeUndefined();
    expect(splitStable("x", 80)).toBeUndefined();
  });

  test("past STREAM_ROWS, everything before the paragraph being written moves to the scrollback", () => {
    const done = Array.from({ length: STREAM_ROWS }, (_, i) => para(i));
    const text = `${done.join("\n\n")}\n\nlive par`;
    const split = splitStable(text, 80);
    expect(split).toBeDefined();
    expect(split?.rest).toBe("live par");
    expect(split?.commit).toBe(done.join("\n\n"));
    expect(split?.gap).toBe(true);
    expect(split?.restInFence).toBe(false);
  });

  test("a blank line inside a code fence is not a paragraph boundary", () => {
    const code = Array.from({ length: 20 }, (_, i) => (i === 10 ? "" : `line ${i}`));
    const split = splitStable(["intro", "", "```ts", ...code].join("\n"), 80);
    // The block is taller than the region, so it is cut by line (no paragraph gap), and the rest
    // knows it is still inside the fence. The inner blank line was not taken for a paragraph end.
    expect(split?.gap).toBe(false);
    expect(split?.restInFence).toBe(true);
    expect(`${split?.commit}\n${split?.rest}`).toBe(["intro", "", "```ts", ...code].join("\n"));
  });

  test("a block taller than the region is cut by line and remembers it is inside a fence", () => {
    const lines = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const a${i} = 1;`)];
    const split = splitStable(lines.join("\n"), 80);
    expect(split?.restInFence).toBe(true);
    expect(split?.gap).toBe(false);
    expect(`${split?.commit}\n${split?.rest}`).toBe(lines.join("\n"));
    // Cutting again knows the rest already starts inside the fence.
    const again = splitStable(`${split?.rest}\n${"const z = 2;\n".repeat(30)}`, 80, true);
    expect(again?.restInFence).toBe(true);
  });

  test("nothing is lost or duplicated across cuts", () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const split = splitStable(text, 80);
    expect(`${split?.commit}\n${split?.rest}`).toBe(text);
  });

  test("long lines count as the rows they wrap to", () => {
    expect(splitStable(`${"x".repeat(78 * STREAM_ROWS)}\nsecond`, 80)).toBeDefined();
  });
});

test("wrapAnsi keeps styles across split rows and leaves fitting rows alone", () => {
  expect(wrapAnsi("short", 10)).toEqual(["short"]);
  const rows = wrapAnsi("\x1b[1mboldtextthatiswaytoolong\x1b[0m", 10);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toBe("\x1b[1mboldtextth\x1b[0m");
  expect(rows[1]).toBe("\x1b[1matiswaytoo\x1b[0m");
});

describe("tool blocks", () => {
  test("the head shows what the call acts on, not its JSON", () => {
    expect(toolSummary("read", { path: "/home/x/a.ts", offset: 3 })).toBe("/home/x/a.ts");
    expect(toolSummary("bash", { cmd: "ls  -la\n| wc" })).toBe("ls -la | wc");
    expect(toolSummary("search", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(toolSummary("mytool", { a: 1 })).toBe('{"a":1}');
  });

  test("name in bold yellow, argument in bold white", () => {
    const head = toolBlock({ name: "read", args: "/a.ts", output: "ok", aborted: false }, false).split("\n")[1] ?? "";
    expect(head).toContain("\x1b[1;38;5;221mread");
    expect(head).toContain("\x1b[1;97m/a.ts");
  });

  test("failures are told apart from successes", () => {
    expect(toolFailed("ERROR: read: no such file")).toBe(true);
    expect(toolFailed("boom\n[exit code 2]")).toBe(true);
    expect(toolFailed("x\n[timed out after 10ms — process group killed]")).toBe(true);
    expect(toolFailed("wrote 8 chars to /a.txt")).toBe(false);
  });

  test("the whole block sits on a soft green band on success and a red one on failure, padded to the width", () => {
    const ok = toolBlock({ name: "bash", args: "ls", output: "a\nb", aborted: false }, false, 20).split("\n");
    // A padding row above and below the head and the two output rows.
    expect(ok).toHaveLength(5);
    expect(stripAnsi(ok[0] ?? "").trim()).toBe("");
    for (const row of ok) {
      expect(row.startsWith("\x1b[48;2;30;44;38m")).toBe(true);
      expect(stripAnsi(row)).toHaveLength(18);
    }
    // A reset inside the head re-opens the band right away.
    expect(ok[1]).toContain("\x1b[0m\x1b[48;2;30;44;38m");
    const bad = toolBlock({ name: "bash", args: "x", output: "nope\n[exit code 1]", aborted: false }, false, 20);
    expect(bad.startsWith("\x1b[48;2;50;30;36m")).toBe(true);
  });

  test("the tool dot is yellow, like the name", () => {
    const region = liveRegion(input({ tool: { name: "bash", args: "ls", output: "", aborted: false } }));
    expect(region.lines[0]?.startsWith("\x1b[38;5;221m●")).toBe(true);
  });
});
