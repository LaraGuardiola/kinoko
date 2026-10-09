import { describe, expect, test } from "bun:test";
import { PANEL_BG, panelRows, panelWidth, shortPath, splitRoom, wideEnough } from "../../tui/panel.ts";
import { visibleLength } from "../../tui/style.ts";
import type { Todo } from "../../tui/todos.ts";

const strip = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");
const plan: Todo[] = [
  { text: "read the loop", status: "done" },
  { text: "draw the panel", status: "in_progress" },
  { text: "tests", status: "pending" },
];

describe("side panel", () => {
  test("shows from two thirds of the screen, or from WIDE_COLS when the screen is unknown; never cramped", () => {
    expect(wideEnough(180, 0.7)).toBe(true);
    expect(wideEnough(180, 0.5)).toBe(false); // a half-screen tile
    expect(wideEnough(150, undefined)).toBe(true);
    expect(wideEnough(120, undefined)).toBe(false);
    expect(wideEnough(90, 1)).toBe(false); // a whole small screen is still too narrow
    expect(panelWidth(100)).toBe(36);
    expect(panelWidth(180)).toBe(49);
    expect(panelWidth(300)).toBe(60);
  });

  test("every row is the panel's width on its background; plan, progress, rule, changes", () => {
    const changes = [
      { path: "src/tui/app.ts", added: 48, removed: 12 },
      { path: "src/tui/panel.ts", added: 214, removed: 0, fresh: true },
      { path: "logo.png", added: 0, removed: 0, binary: true },
    ];
    const facts = { todos: plan, changes };
    const height = 12; // what it needs: padding, header, bar, 3 items, rule, header, 3 files, padding
    const rows = panelRows(facts, 40, height);
    expect(rows).toHaveLength(height);
    for (const row of rows) {
      expect(visibleLength(row)).toBe(40);
      expect(row.startsWith(PANEL_BG)).toBe(true);
    }
    const text = rows.map((r) => strip(r).trimEnd());
    expect(text).toEqual([
      "",
      " Plan                               1/3",
      ` ${"━".repeat(13)}${"━".repeat(25)}`,
      " ✓ read the loop",
      " ● draw the panel",
      " ○ tests",
      ` ${"─".repeat(38)}`,
      " Changes               3 files +262 −12",
      " src/tui/app.ts                 +48 −12",
      " src/tui/panel.ts              new +214",
      " logo.png                           bin",
      "",
    ]);
  });

  test("empty states: no plan yet (and no bar), not a git repository, no changes", () => {
    const none = panelRows({ todos: [], changes: undefined }, 36, 7).map((r) => strip(r).trim());
    expect(none).toEqual(["", "Plan", "no plan yet", "─".repeat(34), "Changes", "not a git repository", ""]);
    expect(panelRows({ todos: [], changes: [] }, 36, 7).map((r) => strip(r).trim())[5]).toBe("no changes");
  });

  test("short of rows: each section gets about half, the plan keeps the work at hand in view", () => {
    expect(splitRoom(3, 4, 10)).toEqual([3, 4]);
    expect(splitRoom(2, 20, 10)).toEqual([2, 8]);
    expect(splitRoom(20, 2, 10)).toEqual([8, 2]);
    expect(splitRoom(20, 20, 10)).toEqual([5, 5]);
    const long: Todo[] = Array.from({ length: 12 }, (_, i) => ({ text: `step ${i + 1}`, status: i < 8 ? "done" : i === 8 ? "in_progress" : "pending" }));
    const changes = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 }));
    const text = panelRows({ todos: long, changes }, 36, 16).map((r) => strip(r).trim());
    expect(text).toHaveLength(16);
    expect(text).toContain("● step 9"); // in progress: in view
    expect(text.some((r) => /^… \d+ more rows?$/.test(r))).toBe(true);
    expect(text.some((r) => /^… \d+ more files?$/.test(r))).toBe(true);
  });

  test("a long path keeps its file name; directories give way from the left", () => {
    expect(shortPath("src/tui/app.ts", 20)).toBe("src/tui/app.ts");
    expect(shortPath("src/very/deep/dir/app.ts", 16)).toBe("…/dir/app.ts");
    expect(shortPath("src/a-very-long-file-name.ts", 12)).toBe("…ile-name.ts");
  });

});
