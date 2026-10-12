import { describe, expect, test } from "bun:test";
import { mushroomArt } from "../../tui/mushroom-art.ts";

// oxlint-disable-next-line no-control-regex -- the colours out, to measure what is seen
const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");
const join = (profile?: string): string => mushroomArt(profile).join("\n");

describe("kinoko in the terminal", () => {
  test("each profile's mushroom: rows 20 columns wide, two pixels per character", () => {
    for (const profile of [undefined, "amanita", "psilocybe", "shiitake", "morchella", "cordyceps", "mycena"]) {
      const rows = mushroomArt(profile);
      expect(rows.length).toBeGreaterThanOrEqual(7);
      expect(rows.length).toBeLessThanOrEqual(9);
      for (const row of rows) expect(plain(row).length).toBe(20);
    }
  });

  test("the same mushroom, its own face: amanita's aura, the others' details; unknown ones smile", () => {
    expect(join("amanita")).toContain("255;196;0"); // the golden aura
    expect(join("amanita").split("\n").length).toBeGreaterThan(join().split("\n").length); // flames above
    expect(join("psilocybe")).toContain("255;122;217");
    expect(join("cordyceps")).toContain("110;231;249"); // its music
    expect(join("morchella")).toContain("229;185;74");
    expect(join("my-own")).toBe(join());
  });
});
