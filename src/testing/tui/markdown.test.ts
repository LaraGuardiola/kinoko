import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../tui/markdown.ts";
import { highlightLine, SYNTAX } from "../../tui/highlight.ts";
import { languageName } from "../../tui/code.ts";
import { visibleLength } from "../../tui/style.ts";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const plain = (text: string, width = 80): string => renderMarkdown(text, { color: false, width });
const rows = (text: string, width = 40): string[] => renderMarkdown(text, { width }).split("\n");

describe("markdown: inline", () => {
  test("bold, italic, strike and inline code drop their markers", () => {
    expect(plain("a **bold** *it* _also_ ~~gone~~ `code` here")).toBe("a bold it also gone code here");
    expect(renderMarkdown("**b**")).toBe("\x1b[1mb\x1b[0m");
  });

  test("spans nest: code inside bold keeps the bold after it", () => {
    const out = renderMarkdown("**`plan` tool**");
    expect(strip(out)).toBe("plan tool");
    // After the code span resets, bold is re-opened for " tool".
    expect(out).toContain("\x1b[0m\x1b[1m tool");
  });

  test("snake_case names and lone markers are left alone; escapes print the character", () => {
    expect(plain("call my_var_name now")).toBe("call my_var_name now");
    expect(plain("a **dangling and `open")).toBe("a **dangling and `open");
    expect(plain("2 \\* 3 = 6")).toBe("2 * 3 = 6");
  });

  test("links show their text, then the url", () => {
    expect(plain("see [the docs](https://x.dev) now")).toBe("see the docs (https://x.dev) now");
  });
});

describe("markdown: blocks", () => {
  test("headings lose their hashes; h1 is amanita red, h2 cream", () => {
    expect(plain("# Title\n## Sub\n### Small")).toBe("Title\nSub\nSmall");
    expect(renderMarkdown("# T")).toContain("\x1b[38;2;232;36;36m");
    expect(renderMarkdown("## T")).toContain("\x1b[38;2;238;222;186m");
  });

  test("bullets, numbers and task boxes; wrapped items hang under their text", () => {
    expect(plain("- one\n* two\n  - nested\n1. first\n- [ ] todo\n- [x] done")).toBe(
      "• one\n• two\n  • nested\n1. first\n☐ todo\n☑ done",
    );
    expect(plain("- alpha beta gamma delta", 13)).toBe("• alpha beta\n  gamma delta");
  });

  test("quotes get a bar on every row, rules span the width", () => {
    expect(plain("> quoted words here", 12)).toBe("│ quoted\n│ words here");
    expect(plain("---", 10)).toBe("─".repeat(10));
  });

  test("paragraphs wrap by word, never mid-word", () => {
    expect(plain("the quick brown fox jumps", 10)).toBe("the quick\nbrown fox\njumps");
  });
});

describe("markdown: tables", () => {
  const table = ["| Name | Size |", "| :--- | ---: |", "| **a** | 1 |", "| bb | 22 |"].join("\n");

  test("a box-drawn grid with inline styles and alignment", () => {
    expect(plain(table)).toBe(
      ["┌──────┬──────┐", "│ Name │ Size │", "├──────┼──────┤", "│ a    │    1 │", "│ bb   │   22 │", "└──────┴──────┘"].join("\n"),
    );
  });

  test("a table wider than the terminal shrinks and wraps its cells, every row the same width", () => {
    const wide = ["| key | description |", "| --- | --- |", `| x | ${"word ".repeat(20).trim()} |`].join("\n");
    const out = rows(wide, 30);
    for (const row of out) expect(visibleLength(row)).toBe(visibleLength(out[0] ?? ""));
    expect(visibleLength(out[0] ?? "")).toBeLessThanOrEqual(30);
    expect(out.length).toBeGreaterThan(6);
  });
});

describe("markdown: code blocks", () => {
  const code = ["intro", "```ts", "const a = 1; // one", "function f() { return \"s\"; }", "```", "after"].join("\n");

  test("an editor pane: language label, numbered lines, every row the full width", () => {
    const out = rows(code, 40);
    expect(out[0]).toBe("intro");
    expect(out.at(-1)).toBe("after");
    const pane = out.slice(1, -1);
    for (const row of pane) expect(visibleLength(row)).toBe(40);
    // A padding row, then the full language name top right, two columns in from the edge.
    expect(strip(pane[0] ?? "").trim()).toBe("");
    expect(strip(pane[1] ?? "")).toMatch(/ {20,}TypeScript {3}$/);
    expect(strip(pane[2] ?? "")).toStartWith(" 1  const a = 1;");
    expect(strip(pane[3] ?? "")).toStartWith(" 2  function f()");
    // The panel background is never cut mid-row by a full reset.
    for (const row of pane) expect(row.slice(0, -4)).not.toMatch(new RegExp(`${ESC}\\[0m(?!${ESC}\\[48)`));
  });

  test("code is coloured but never inline-formatted", () => {
    const out = renderMarkdown("```js\nconst a = **b**;\n```", { width: 40 });
    expect(strip(out)).toContain("const a = **b**;");
    expect(out).toContain(`${SYNTAX.keyword}const`);
  });

  test("a run with no break opportunity is cut by column, with an empty gutter", () => {
    const out = rows(`\`\`\`\n${"x".repeat(50)}\n\`\`\``, 30);
    expect(out).toHaveLength(6); // top padding, label row, three cut rows, bottom padding
    for (const row of out) expect(visibleLength(row)).toBe(30);
    expect(strip(out[3] ?? "")).toStartWith("      x");
  });

  test("long lines soft-wrap at token boundaries, hanging under their own indentation", () => {
    const line = '  const errors = messages.filter(m => m.role === "tool").some(m => m.text.startsWith("E"));';
    const out = rows(`\`\`\`ts\n${line}\n\`\`\``, 62).map(strip);
    expect(out[2]?.trimEnd()).toBe(' 1    const errors = messages.filter(m => m.role === "tool")');
    // The continuation hangs two columns past the line's indentation and starts at the dot.
    expect(out[3]).toStartWith("        .some(m => m.text");
    for (const row of out) expect(row.length).toBe(62);
  });

  test("language labels are full names", () => {
    expect(languageName("ts")).toBe("TypeScript");
    expect(languageName("py")).toBe("Python");
    expect(languageName("sh")).toBe("Shell");
    expect(languageName("elixir")).toBe("Elixir");
  });

  test("a fence still streaming (no closing line) renders what has arrived", () => {
    const out = rows("```py\ndef f():", 30);
    expect(strip(out[2] ?? "")).toStartWith(" 1  def f():");
  });
});

describe("syntax highlighting", () => {
  test("keywords, strings, numbers, comments, calls and types", () => {
    const { text } = highlightLine('const x: Foo = bar(42, "s"); // note', "ts");
    expect(text).toContain(`${SYNTAX.keyword}const`);
    expect(text).toContain(`${SYNTAX.type}Foo`);
    expect(text).toContain(`${SYNTAX.fn}bar`);
    expect(text).toContain(`${SYNTAX.number}42`);
    expect(text).toContain(`${SYNTAX.string}"s"`);
    expect(text).toContain(`${SYNTAX.comment}// note`);
    expect(strip(text)).toBe('const x: Foo = bar(42, "s"); // note');
  });

  test("lowercase built-in types are types too", () => {
    const { text } = highlightLine("function f(a: string, n: number): boolean {}", "ts");
    for (const type of ["string", "number", "boolean"]) expect(text).toContain(`${SYNTAX.type}${type}`);
    expect(highlightLine("let x: i32 = 0;", "rust").text).toContain(`${SYNTAX.type}i32`);
    expect(highlightLine("def f(a: int) -> str:", "py").text).toContain(`${SYNTAX.type}str`);
  });

  test("a block comment carries over to the next line", () => {
    const first = highlightLine("a /* open", "c");
    expect(first.state.inBlock).toBe(true);
    const second = highlightLine("still */ b", "c", first.state);
    expect(second.text).toStartWith(`${SYNTAX.comment}still */`);
    expect(second.state.inBlock).toBe(false);
  });

  test("json keys, shell variables and comments, python, diff", () => {
    expect(highlightLine('{"name": "x"}', "json").text).toContain(`${SYNTAX.property}"name"`);
    const sh = highlightLine("echo $HOME # hi", "bash").text;
    expect(sh).toContain(`${SYNTAX.variable}$HOME`);
    expect(sh).toContain(`${SYNTAX.comment}# hi`);
    expect(highlightLine("url#anchor", "sh").text).not.toContain(SYNTAX.comment);
    expect(highlightLine("def f(): pass", "python").text).toContain(`${SYNTAX.keyword}def`);
    expect(highlightLine("+added", "diff").text).toBe(`${SYNTAX.added}+added\x1b[39m`);
  });

  test("interpolations are code: ${expr} in template literals, $VAR in shell double quotes", () => {
    const { text } = highlightLine("`a ${count} b ${x.f()}`", "ts");
    expect(text).toContain(`${SYNTAX.interp}\${`);
    expect(text).toContain(`${SYNTAX.plain}count`);
    expect(text).toContain(`${SYNTAX.fn}f`);
    expect(text).toContain(`${SYNTAX.string} b `);
    expect(strip(text)).toBe("`a ${count} b ${x.f()}`");
    expect(highlightLine('echo "at $HOME now"', "sh").text).toContain(`${SYNTAX.variable}$HOME`);
    expect(highlightLine("'no $HOME here'", "sh").text).not.toContain(SYNTAX.variable);
  });

  test("an unknown language is plain text", () => {
    expect(strip(highlightLine("whatever **x**", "nope").text)).toBe("whatever **x**");
  });
});
