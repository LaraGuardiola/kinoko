import { expect, test, describe } from "bun:test";
import { formatBlock, liveRegion, splitStable, STREAM_ROWS, wrapAnsi } from "../../tui/view.ts";
import { pulseDot, pulseLevel, toolBlock, toolFailed, toolSummary } from "../../tui/tools.ts";
import { visibleLength } from "../../tui/style.ts";
import type { RegionInput } from "../../tui/view.ts";

const stripAnsi = (line: string): string => line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

function input(over: Partial<RegionInput> = {}): RegionInput {
  return {
    open: undefined,
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
    ...over,
  };
}

describe("live region", () => {
  test("idle: a blank row, the editor between two red rules with only the cursor, the status", () => {
    const region = liveRegion(input({ viewportRows: 10, viewportCols: 20 }));
    const plain = region.lines.map(stripAnsi);
    expect(plain).toEqual(["", "─".repeat(18), " ", "─".repeat(18), " IDLE "]);
    expect(region.lines[2]).toBe("\x1b[7m \x1b[0m");
    expect(region.row).toBe(2);
  });

  test("the thinking level sits near the right end of the rule above the editor, same width", () => {
    const region = liveRegion(input({ viewportRows: 10, viewportCols: 30, thinking: "LOW · 2048" }));
    const plain = region.lines.map(stripAnsi);
    expect(plain[1]).toBe(`${"─".repeat(14)} LOW · 2048 ──`);
    expect(plain[1]!.length).toBe(plain[3]!.length); // the bottom rule stays plain, same width
    expect(region.lines[1]).toContain("\x1b[1m\x1b[38;2;238;222;186mLOW · 2048"); // bold cream
    // Too narrow for the label: a plain rule.
    expect(stripAnsi(liveRegion(input({ viewportCols: 12, thinking: "LOW · 2048" })).lines[1]!)).toBe("─".repeat(10));
  });

  test("the path is cream and the branch amanita red", () => {
    const region = liveRegion(input({ place: "~/p (master)" }));
    expect(region.lines.at(-2)).toBe("\x1b[38;2;238;222;186m~/p\x1b[0m \x1b[38;2;232;36;36m(master)\x1b[0m");
  });

  test("the block cursor sits on the character under it, or past the end of the line", () => {
    const mid = liveRegion(input({ editorLines: ["abc"], editorCol: 1 }));
    expect(mid.lines[2]).toBe("a\x1b[7mb\x1b[0mc");
    const end = liveRegion(input({ editorLines: ["abc"], editorCol: 3 }));
    expect(end.lines[2]).toBe("abc\x1b[7m \x1b[0m");
  });

  test("the place line goes under the bottom rule, above the status", () => {
    const region = liveRegion(input({ place: "~/Projects/kinoko (master)" }));
    const plain = region.lines.map(stripAnsi);
    expect(plain.slice(-2)).toEqual(["~/Projects/kinoko (master)", " IDLE "]);
  });

  test("finished history is NOT part of the region any more (it lives in the scrollback)", () => {
    const region = liveRegion(input({ viewportRows: 10 }));
    expect(region.lines.join("\n")).not.toContain("answer");
    expect(Object.keys(region).toSorted()).toEqual(["col", "lines", "row", "upper"]);
  });

  test("the open block renders above the editor, the thinking style is dim italic", () => {
    const region = liveRegion(input({ open: { kind: "thinking", text: "reasoning", gap: false } }));
    expect(region.lines[0]).toBe("\x1b[2m\x1b[3mreasoning\x1b[0m");
    const answer = liveRegion(input({ open: { kind: "assistant", text: "answer", gap: false } }));
    expect(answer.lines[0]).toBe("answer");
  });

  test("only ONE block is ever open: thinking and answer are never in the region together", () => {
    const region = liveRegion(input({ open: { kind: "assistant", text: "answer", gap: false } }));
    expect(region.lines.filter((line) => stripAnsi(line) === "reasoning")).toHaveLength(0);
  });

  test("a gap puts a blank row before the open block", () => {
    const region = liveRegion(input({ open: { kind: "assistant", text: "x", gap: true } }));
    expect(region.lines.slice(0, 2)).toEqual(["", "x"]);
  });

  test("a short viewport keeps the tail of the open block with the editor pinned below it", () => {
    const region = liveRegion(
      input({
        open: { kind: "assistant", text: "one\ntwo\nthree\nfour", gap: false },
        editorLines: ["draft"],
        editorCol: 5,
        viewportRows: 6,
      }),
    );
    expect(region.lines.map(stripAnsi).filter((line) => !line.startsWith("─"))).toEqual(["four", "", "draft ", " IDLE "]);
    expect(region.row).toBe(3);
  });

  test("a tiny viewport drops the chrome but keeps the editor and the status", () => {
    const region = liveRegion(input({ editorLines: ["x"], editorCol: 1, viewportRows: 3 }));
    expect(region.lines.map(stripAnsi)).toEqual(["x ", " IDLE "]);
    expect(region.row).toBe(0);
  });

  test("the region never exceeds the viewport", () => {
    const text = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n");
    const region = liveRegion(
      input({ open: { kind: "assistant", text, gap: false }, queued: [{ kind: "steer", text: "later" }], viewportRows: 8 }),
    );
    expect(region.lines.length).toBeLessThanOrEqual(8);
  });

  test("clips styled rows before the terminal margin", () => {
    const region = liveRegion(
      input({ editorLines: ["abcdefgh"], editorCol: 8, viewportRows: 3, viewportCols: 6 }),
    );
    expect(region.lines[0]).toBe("abc…\x1b[0m");
    expect(region.col).toBe(4);
  });

  test("long streaming rows wrap to the full width instead of ending in an ellipsis", () => {
    const region = liveRegion(
      input({
        open: { kind: "assistant", text: "x ".repeat(50), gap: false },
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
    expect(plain[1]).toBe("");
    expect(plain[2]).toBe("Interrupted");
    // A row of air, the keys that act on the queue (dim), then the message in cream.
    expect(plain[3]).toBe("");
    expect(plain[4]).toBe("alt+c cancel · alt+↑ edit the last");
    expect(plain[5]).toBe("[follow-up] next");
    expect(region.lines[5]).toStartWith("\x1b[38;2;238;222;186m");
  });

  test("a waiting steer offers alt+x to send it now", () => {
    const region = liveRegion(input({ queued: [{ kind: "steer", text: "use rg" }] }));
    const plain = region.lines.map(stripAnsi);
    expect(plain.slice(0, 3)).toEqual(["", "alt+x send now · alt+c cancel · alt+↑ edit the last", "[steer] use rg"]);
  });

  test("the compaction note is cream, with no background", () => {
    const region = liveRegion(input({ marker: "compacting…", markerCream: true }));
    expect(region.lines[1]).toBe("\x1b[38;2;238;222;186mcompacting…\x1b[0m");
  });

  test("an interruption sits after a blank row, in the same red as the input rules", () => {
    const region = liveRegion(input({ open: { kind: "assistant", text: "partial", gap: false }, marker: "Interrupted", markerAlert: true }));
    expect(region.lines.slice(0, 3)).toEqual(["partial", "", "\x1b[38;2;232;36;36mInterrupted\x1b[0m"]);
    expect(region.lines[4]).toStartWith("\x1b[38;2;232;36;36m─");
  });
});

describe("tool in progress", () => {
  test("the bullet fades from dim amber to the resting yellow and back, in quantized steps", () => {
    expect(pulseLevel(0)).toBe(0);
    expect(pulseLevel(99)).toBe(0); // one step lasts 100 ms: few repaints
    expect(pulseLevel(600)).toBeCloseTo(1);
    expect(pulseLevel(300)).toBeCloseTo(0.5);
    expect(pulseLevel(1200)).toBe(0); // and round again
    expect(pulseDot(0)).toBe("\x1b[38;2;70;58;22m");
    expect(pulseDot(1)).toBe("\x1b[38;2;255;215;95m");
  });

  test("the running line takes the pulse colour; without a pulse the bullet keeps its own", () => {
    const tool = { name: "write", args: "", output: "", aborted: false };
    const lit = liveRegion(input({ tool, pulse: 0 }));
    expect(lit.lines.find((l) => l.includes("write"))).toStartWith("\x1b[38;2;70;58;22m●");
    const plain = liveRegion(input({ tool }));
    expect(plain.lines.find((l) => l.includes("write"))).toStartWith("\x1b[38;5;221m●");
  });
});

describe("terminal widths", () => {
  test("wide emoji and CJK take two columns, combining marks none", () => {
    expect(visibleLength("ok ✅")).toBe(5);
    expect(visibleLength("日本")).toBe(4);
    expect(visibleLength("e\u0301")).toBe(1);
    expect(visibleLength("\x1b[1mbold\x1b[0m")).toBe(4);
  });

  test("a band row with an emoji never spills past its width", () => {
    const block = toolBlock({ name: "read", args: "a", output: `3: ## Phase 1 ✅ ${"x".repeat(40)}`, aborted: false }, false, 30);
    for (const row of block.split("\n")) expect(visibleLength(row)).toBe(28);
  });
});

describe("formatBlock", () => {
  test("user messages are light blue on every row, with no prompt mark", () => {
    expect(formatBlock("user", "help me")).toBe("\x1b[38;5;159mhelp me\x1b[0m");
    expect(formatBlock("user", "another\nmessage")).toBe(
      "\x1b[38;5;159manother\x1b[0m\n\x1b[38;5;159mmessage\x1b[0m",
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

  test("assistant text is wrapped by word to the width it is given", () => {
    const rows = formatBlock("assistant", "alpha beta gamma delta epsilon", 12).split("\n");
    expect(rows).toEqual(["alpha beta", "gamma delta", "epsilon"]);
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
  });

  test("a code block is never cut: it stays live until it closes, whatever its height", () => {
    const code = Array.from({ length: 30 }, (_, i) => (i === 10 ? "" : `line ${i}`));
    const split = splitStable(["intro", "", "```ts", ...code].join("\n"), 80);
    // The blank line inside the fence is not a paragraph end: only the intro may move.
    expect(split?.commit).toBe("intro");
    expect(split?.rest.startsWith("```ts")).toBe(true);
    expect(splitStable(["```ts", ...code].join("\n"), 80)).toBeUndefined();
  });

  test("after the fence closes, the whole block moves at once", () => {
    const lines = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const a${i} = 1;`), "```", "", "after"];
    const split = splitStable(lines.join("\n"), 80);
    expect(split?.rest).toBe("after");
    expect(split?.commit.endsWith("```")).toBe(true);
  });

  test("a table is never cut between its rows", () => {
    const rows = ["| a | b |", "| - | - |", ...Array.from({ length: 30 }, (_, i) => `| ${i} | x |`)];
    expect(splitStable(["intro", "", ...rows].join("\n"), 80)?.commit).toBe("intro");
    expect(splitStable(rows.join("\n"), 80)).toBeUndefined();
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
    // A todo call: how far the plan is and the step at hand, never its JSON.
    const items = [{ text: "read", status: "done" }, { text: "write the parser", status: "in_progress" }, { text: "tests", status: "pending" }];
    expect(toolSummary("todo", { items })).toBe("1/3 · write the parser");
    expect(toolSummary("todo", { items: [{ text: "a", status: "done" }] })).toBe("1/1 · all done");
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

const strip = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("beside a side column", () => {
  test("the streamed text takes tailCols; the rules, editor and status keep the full width; upper counts the rows above the rule", () => {
    const r = liveRegion(input({ open: { kind: "assistant", text: "word ".repeat(20).trim(), gap: false }, tailCols: 30, viewportCols: 80, viewportRows: 30, place: "~/p" }));
    const rows = r.lines.map(strip);
    const rule = rows.findIndex((row) => row.startsWith("───"));
    expect(r.upper).toBe(rule); // the streamed rows and the blank row before the rule
    for (const row of rows.slice(0, rule)) expect(row.length).toBeLessThanOrEqual(28);
    expect(rows[rule]!.length).toBe(78);
    expect(rows.at(-1)).toContain("IDLE");
  });
});

test("system blocks break between words and keep each line's indent; without a width they stay as written", () => {
  const intro = "Kinoko can inspect and change this project.\n  Skills: diagnose-crash, flux-send, omarchy";
  expect(formatBlock("system", intro, 20)).toBe("Kinoko can inspect\nand change this\nproject.\n  Skills:\n  diagnose-crash,\n  flux-send, omarchy");
  expect(formatBlock("system", intro)).toBe(intro);
});
