import { describe, expect, test } from "bun:test";
import { qr, qrText } from "../../serve/qr.ts";

/** A 7×7 finder pattern with its top-left corner at (x, y). */
function finder(grid: boolean[][], x: number, y: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if ((grid[y + dy]?.[x + dx] ?? false) !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe("serve: QR codes", () => {
  test("the version grows with the text (21 modules for a short one, 4 more per version)", () => {
    expect(qr("hi").length).toBe(21);
    expect(qr("x".repeat(100)).length).toBe(41); // version 6 at level M
    expect(qr("x".repeat(1000)).length % 4).toBe(1);
  });

  test("three finder patterns in their corners, timing lines between them", () => {
    const g = qr("kinoko://pair?u=https%3A%2F%2Fhost.ts.net%3A8443&c=abc");
    const n = g.length;
    expect(finder(g, 0, 0)).toBe(true);
    expect(finder(g, n - 7, 0)).toBe(true);
    expect(finder(g, 0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i++) expect(g[6]?.[i]).toBe(i % 2 === 0);
    expect(g[n - 8]?.[8]).toBe(true); // the dark module
  });

  test("the same text always draws the same code; too much text is refused", () => {
    expect(qr("same")).toEqual(qr("same"));
    expect(() => qr("x".repeat(3000))).toThrow("too long");
  });

  test("drawn for a terminal: two rows per line, black on white, a quiet zone", () => {
    const lines = qrText("hi").split("\n");
    expect(lines).toHaveLength(13); // (21 + 2×2) / 2, rounded up
    expect(lines[0]).toStartWith("\x1b[30;47m");
    expect(lines[0]).toEndWith("\x1b[0m");
  });
});
