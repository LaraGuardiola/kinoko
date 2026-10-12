import { describe, expect, test } from "bun:test";
import { FilePicker, atQuery, narrow, splitQuery } from "../../tui/files.ts";
import type { Entry } from "../../tui/files.ts";
import { resolve } from "node:path";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("@ file references", () => {
  test("the @ word at the cursor: at the start or after a space, never inside a word (an email)", () => {
    expect(atQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(atQuery("look at @src/tu", 15)).toEqual({ start: 8, query: "src/tu" });
    expect(atQuery("look at @src/tu and", 19)).toBeUndefined(); // the cursor left the word
    expect(atQuery("mail me@host", 12)).toBeUndefined();
    expect(splitQuery("src/tu")).toEqual({ dir: "src/", prefix: "tu" });
    expect(splitQuery("REA")).toEqual({ dir: "", prefix: "REA" });
  });

  test("narrowing: prefix matches first, directories first, dotfiles only when asked for", () => {
    const entries: Entry[] = [
      { name: "main.ts", dir: false },
      { name: "domain", dir: true },
      { name: "manual.md", dir: false },
      { name: "maps", dir: true },
      { name: ".mailrc", dir: false },
    ];
    expect(narrow(entries, "ma").map((e) => e.name)).toEqual(["maps", "main.ts", "manual.md", "domain"]);
    expect(narrow(entries, ".ma").map((e) => e.name)).toEqual([".mailrc"]);
  });

  test("the picker lists the typed directory, completes a directory in place and a file with a space", async () => {
    const asked: string[] = [];
    // Keyed by the resolved path: "/p" is "D:\\p" on Windows.
    const tree: Record<string, Entry[]> = {
      [resolve("/p")]: [{ name: "src", dir: true }, { name: "README.md", dir: false }],
      [resolve("/p/src")]: [{ name: "app.ts", dir: false }],
    };
    let changes = 0;
    const picker = new FilePicker("/p", () => changes++, async (dir) => (asked.push(dir), tree[dir] ?? []));
    picker.sync("see @", 5);
    expect(picker.open).toBe(true);
    expect(picker.entries).toBeUndefined(); // still reading
    await tick();
    expect(changes).toBe(1);
    expect(picker.items().map((i) => i.name)).toEqual(["src/", "README.md"]);
    expect(picker.accept()).toEqual({ start: 4, end: 5, text: "@src/" });
    picker.sync("see @src/", 9);
    await tick();
    expect(picker.where).toBe("src/");
    expect(picker.accept()).toEqual({ start: 4, end: 9, text: "@src/app.ts " });
    picker.sync("see @src/app.ts ", 16);
    expect(picker.open).toBe(false);
    expect(asked).toEqual([resolve("/p"), resolve("/p/src")]); // each directory read once
    // Esc closes it for this word; a new @ opens it again, reading afresh.
    picker.sync("@", 1);
    picker.dismiss();
    expect(picker.open).toBe(false);
    picker.sync("@R", 2);
    expect(picker.open).toBe(false);
    picker.sync("", 0);
    picker.sync("@", 1);
    expect(picker.open).toBe(true);
    await tick();
    expect(asked).toEqual([resolve("/p"), resolve("/p/src"), resolve("/p"), resolve("/p")]);
  });
});
