import { describe, expect, test } from "bun:test";
import { compactingNote, sprouts } from "../../tui/sprout.ts";
import { visibleLength } from "../../tui/style.ts";

describe("compacting note", () => {
  test("mushrooms sprout one by one, then go one by one; the row keeps its width", () => {
    const frames = Array.from({ length: 10 }, (_, i) => sprouts(i * 280));
    expect(frames.map((f) => [...f.matchAll(/🍄/g)].length)).toEqual([1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);
    expect(frames[0]).toBe(`🍄${"  ".repeat(4)}`); // the first sprouts on the left
    expect(frames[6]).toBe(`${"  ".repeat(2)}🍄🍄🍄`); // they go from the left too
    for (const f of frames) expect(visibleLength(f)).toBe(10);
    expect(sprouts(10 * 280)).toBe(frames[0]!); // and again
  });

  test("reading as the server reports it, then the summary being written", () => {
    expect(compactingNote({ phase: "reading", done: 0, total: 28_100 }, 0)).toEndWith("compacting… reading ~28,100 tokens");
    expect(compactingNote({ phase: "reading", done: 12_400, total: 28_100 }, 0)).toEndWith("compacting… reading 12,400 / 28,100 tokens");
    expect(compactingNote({ phase: "writing", done: 412 }, 0)).toEndWith("compacting… writing the summary · 412 tokens");
  });
});
