import { describe, expect, test } from "bun:test";
import { isTree, isTreeLine, treeRows } from "../../tui/tree.ts";
import { renderMarkdown } from "../../tui/markdown.ts";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("directory trees", () => {
  test("tree lines: guides then a connector, box-drawn or ASCII", () => {
    for (const line of ["├── a", "│   └── b", "|-- c", "`-- d", "    \\-- e"]) expect(isTreeLine(line)).toBe(true);
    for (const line of ["a ├── b", "- item", "x--y"]) expect(isTreeLine(line)).toBe(false);
    expect(isTree(["src/", "├── a.ts"])).toBe(false);
  });

  test("ASCII guides become box lines; comments keep their alignment", () => {
    const rows = treeRows(["app/", "|-- src/      # code", "|   `-- main.ts", "`-- README.md # docs"], 80, false);
    expect(rows).toEqual(["app/", "├── src/      # code", "│   └── main.ts", "└── README.md # docs"]);
  });

  test("folders (a slash, or rows under them) are coloured; files are not", () => {
    const rows = treeRows(["root", "├── lib", "│   └── x.ts", "└── y.ts"], 80);
    expect(rows[0]).toContain(`${ESC}[1m`);
    expect(rows[1]).toContain(`${ESC}[1m`);
    expect(rows[3]).not.toContain(`${ESC}[1m`);
  });

  test("a long row wraps under its name with the guides kept", () => {
    const rows = treeRows(["├── tui/  # the terminal UI, raw ANSI and nothing else", "└── z"], 30, false);
    expect(rows[0]).toBe("├── tui/  # the terminal UI,");
    expect(rows[1]).toBe("│     raw ANSI and nothing");
    expect(rows.at(-1)).toBe("└── z");
  });

  test("in a fence: a Tree panel; outside one: never read as markdown", () => {
    const fenced = renderMarkdown(["```", "src/", "├── a.ts", "└── b.ts", "```"].join("\n"), { width: 40 });
    expect(strip(fenced)).toContain("Tree");
    const bare = renderMarkdown(["pkg/", "├── __init__.py", "└── core.py"].join("\n"), { color: false, width: 40 });
    expect(bare).toBe("pkg/\n├── __init__.py\n└── core.py");
  });
});
