import { describe, expect, test } from "bun:test";
import { PANEL_BG, columns, panelBand, shortPath, wideEnough } from "../../tui/panel.ts";
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
    expect(columns(100)).toEqual([53, 44]); // the plan a little wider: its lines are longer
  });

  test("one band: every row the full width on its background, plan | changes, padding above and below", () => {
    const changes = [
      { path: "src/tui/app.ts", added: 48, removed: 12 },
      { path: "src/tui/panel.ts", added: 214, removed: 0, fresh: true },
      { path: "logo.png", added: 0, removed: 0, binary: true },
    ];
    const rows = panelBand({ todos: plan, changes }, 80, 20);
    for (const row of rows) {
      expect(visibleLength(row)).toBe(80);
      expect(row.startsWith(PANEL_BG)).toBe(true);
    }
    const [left] = columns(78);
    const text = rows.map((r) => strip(r));
    expect(text).toHaveLength(7); // as tall as the taller column (header, bar, 3 items) plus padding
    expect(text[0]!.trim()).toBe("");
    expect(text.at(-1)!.trim()).toBe("");
    const halves = text.slice(1, -1).map((r) => [r.slice(1, 1 + left).trimEnd(), r.slice(1 + left + 3).trimEnd()]);
    expect(halves).toEqual([
      [`Plan${" ".repeat(left - 7)}1/3`, "Changes           3 files +262 −12"],
      [`${"━".repeat(14)}${"━".repeat(left - 14)}`, "src/tui/app.ts             +48 −12"],
      ["✓ read the loop", "src/tui/panel.ts          new +214"],
      ["● draw the panel", "logo.png                       bin"],
      ["○ tests", ""],
    ]);
    expect(text[1]!.charAt(1 + left + 1)).toBe("│"); // the divider, straight down the band
    expect(text[5]!.charAt(1 + left + 1)).toBe("│");
  });

  test("empty states: no plan yet (and no bar), not a git repository, no changes", () => {
    const none = panelBand({ todos: [], changes: undefined }, 80, 20).map((r) => strip(r));
    expect(none).toHaveLength(4);
    expect(none[1]).toMatch(/^ Plan +│ Changes +$/);
    expect(none[2]).toMatch(/^ no plan yet +│ not a git repository +$/);
    expect(panelBand({ todos: [], changes: [] }, 80, 20).map((r) => strip(r))[2]).toContain("no changes");
  });

  test("capped: a long plan keeps the work at hand in view, long changes say how many more", () => {
    const long: Todo[] = Array.from({ length: 16 }, (_, i) => ({ text: `step ${i + 1}`, status: i < 8 ? "done" : i === 8 ? "in_progress" : "pending" }));
    const changes = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 }));
    const text = panelBand({ todos: long, changes }, 80, 10).map((r) => strip(r));
    expect(text).toHaveLength(10);
    expect(text.some((r) => r.includes("● step 9"))).toBe(true);
    expect(text.some((r) => /… \d+ more rows?/.test(r))).toBe(true);
    expect(text.some((r) => /… \d+ more files?/.test(r))).toBe(true);
  });

  test("a long path keeps its file name; directories give way from the left", () => {
    expect(shortPath("src/tui/app.ts", 20)).toBe("src/tui/app.ts");
    expect(shortPath("src/very/deep/dir/app.ts", 16)).toBe("…/dir/app.ts");
    expect(shortPath("src/a-very-long-file-name.ts", 12)).toBe("…ile-name.ts");
  });

});
