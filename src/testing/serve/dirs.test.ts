import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome, folders } from "../../serve/dirs.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-dirs-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const d of ["Projects/kinoko", "Projects/kinoko-android", "Projects/web", "Music", ".config"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, "Projects", "notes.txt"), "");

describe("a path typed on the phone", () => {
  test("~ is this user's home", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/Projects", home)).toBe(join(home, "Projects"));
    expect(expandHome("/srv/x/../y", home)).toBe(resolve("/srv/y")); // D:\srv\y on Windows
  });

  test("completed with the folders that start with it, any case; files and hidden ones left out", async () => {
    expect(await folders("~/", home)).toEqual([join(home, "Music"), join(home, "Projects")]);
    expect(await folders("~/proj", home)).toEqual([join(home, "Projects")]);
    expect(await folders("~/Projects/", home)).toEqual(["kinoko", "kinoko-android", "web"].map((d) => join(home, "Projects", d)));
    expect(await folders("~/Projects/kin", home)).toEqual(["kinoko", "kinoko-android"].map((d) => join(home, "Projects", d)));
    expect(await folders("~/.co", home)).toEqual([join(home, ".config")]);
    expect(await folders("~/nowhere/", home)).toEqual([]);
  });
});
