import { describe, expect, test } from "bun:test";
import { MENU_ROWS, Menu, ORANGE, filterRoot, listRows, pageRows } from "../../tui/menu.ts";
import type { ListPage } from "../../tui/menu.ts";
import { ROOT, THINKING, profileLabel, sessionLines, thinkingPage } from "../../tui/menu-pages.ts";

const strip = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `item${i}`, description: `about ${i}` }));

describe("slash menu state", () => {
  test("arrows wrap at both ends; a filter that narrows the list keeps the selection inside it", () => {
    const menu = new Menu();
    menu.move(-1, 3);
    expect(menu.index).toBe(2);
    menu.move(1, 3);
    expect(menu.index).toBe(0);
    menu.move(2, 3);
    menu.clamp(1);
    expect(menu.index).toBe(0);
  });

  test("a page opens on its current item; Esc goes back to the root, then has nothing to go back to", () => {
    const menu = new Menu();
    menu.open(thinkingPage("medium", () => undefined));
    expect(menu.index).toBe(THINKING.findIndex((p) => p.name === "medium"));
    expect(menu.back()).toBe(true);
    expect(menu.page).toBeUndefined();
    expect(menu.back()).toBe(false);
  });

  test("a list that finishes loading replaces the open page, never another one", () => {
    const menu = new Menu();
    const loading: ListPage = { kind: "list", title: "Models", items: [], empty: "asking…", pick: () => undefined };
    menu.open(loading);
    menu.refresh(loading, { ...loading, title: "Models", items: items(2) }); // even with a new title
    expect((menu.page as ListPage).items).toHaveLength(2);
    menu.back();
    menu.refresh(loading, { ...loading, items: items(3) }); // the user left: it must not reopen
    expect(menu.page).toBeUndefined();
  });

  test("the root filters by what follows the slash", () => {
    expect(filterRoot(ROOT, "/").map((i) => i.name)).toEqual(ROOT.map((i) => i.name));
    expect(filterRoot(ROOT, "/th").map((i) => i.name)).toEqual(["thinking"]);
    expect(filterRoot(ROOT, "/zz")).toEqual([]);
  });
});

describe("slash menu rows", () => {
  test("arrow on the selection, names in orange, a count, and only MENU_ROWS items at once", () => {
    const rows = listRows(items(20), 15);
    const plain = rows.map(strip);
    expect(plain.filter((r) => r.startsWith("→"))).toEqual(["→ item15    about 15"]); // names padded to the longest + 4
    expect(plain.at(-1)).toBe("  (16/20)");
    expect(rows.length).toBe(MENU_ROWS + 1);
    expect(rows[0]).toContain(ORANGE);
  });

  test("a page has its title; the current item is marked; an empty list says why", () => {
    const thinking = pageRows(thinkingPage("low", () => undefined), 0).map(strip);
    expect(thinking[0]).toBe("Thinking");
    expect(thinking.find((r) => r.includes("low"))).toContain("● ");
    expect(pageRows({ kind: "list", title: "Models", items: [], empty: "asking the engine…", pick: () => undefined }, 0).map(strip)).toEqual([
      "Models",
      "  asking the engine…",
    ]);
  });

  test("the thinking label shows the budget only where one applies", () => {
    const [off, low, , , extreme] = THINKING;
    expect(profileLabel(low!, true)).toBe("LOW · 2048");
    expect(profileLabel(low!, false)).toBe("LOW");
    expect(profileLabel(off!, true)).toBe("OFF");
    expect(profileLabel(extreme!, true)).toBe("EXTREME");
  });

  test("the session page is a table of the session's facts", () => {
    const lines = sessionLines(
      {
        path: "/home/u/.kinoko/sessions/x/abc.jsonl",
        id: "abc",
        created: 0,
        messages: [
          { id: "1", role: "user", content: "hi" },
          { id: "2", role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", args: {} }], usage: { input: 1000, output: 50 } },
          { id: "3", role: "tool", toolCallId: "c", content: "ok" },
          { id: "4", role: "user", content: "[kinoko] nudge" },
        ],
        context: 1050,
        window: 10_000,
      },
      80,
    ).map(strip);
    expect(lines[0]).toStartWith("┌");
    const text = lines.join("\n");
    expect(text).toContain("/home/u/.kinoko/sessions/x/abc.jsonl");
    expect(text).toContain("4 (user 1, assistant 1)"); // the loop's nudge is not the user
    expect(text).toContain("1 calls, 1 results");
    expect(text).toContain("1,050 / 10,000 (11%)");
    expect(text).toContain("1,000 sent, 50 generated");
  });
});
