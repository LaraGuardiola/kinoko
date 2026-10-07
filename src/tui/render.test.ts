import { expect, test, describe } from "bun:test";
import { Renderer } from "./render.ts";
import { renderMarkdown } from "./markdown.ts";

/** Collects every write, with a clock the test drives. */
function harness(start = 0): { renderer: Renderer; out: string[]; tick: (ms: number) => boolean } {
  const out: string[] = [];
  let now = start;
  const renderer = new Renderer({ write: (text) => out.push(text), now: () => now });
  return {
    renderer: renderer,
    out: out,
    tick: (ms: number) => {
      now += ms;
      return renderer.frame();
    },
  };
}

describe("tui renderer", () => {
  test("1. draws the live region and leaves the cursor where it was asked", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["thinking...", "> draft"], row: 1, col: 6 });
    expect(tick(50)).toBe(true);
    // The final row has no newline: a full-height region must never scroll during a repaint.
    expect(out[0]).toBe("\x1b[2K\rthinking...\n\x1b[2K\r> draft\x1b[J\x1b[7G");
    expect(renderer.drawn).toEqual(["thinking...", "> draft"]);
  });

  test("2. an unchanged frame is not repainted, and the throttle holds it back", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["same"], row: 0, col: 0 });
    tick(50);
    expect(out).toHaveLength(1);
    expect(tick(10)).toBe(false); // throttled: only 10ms since the last paint
    expect(out).toHaveLength(1);
    expect(tick(30)).toBe(false); // nothing changed either
    // Even past the throttle, an identical frame is not repainted.
    renderer.update({ lines: ["same"], row: 0, col: 0 });
    expect(tick(1)).toBe(false);
    expect(tick(40)).toBe(false);
    expect(out).toHaveLength(1);
    // A real change paints.
    renderer.update({ lines: ["changed"], row: 0, col: 0 });
    expect(tick(40)).toBe(true);
    expect(out).toHaveLength(2);
  });

  test("3. a shorter frame clears what the taller one left behind", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["one", "two", "three"], row: 0, col: 0 });
    tick(50);
    renderer.update({ lines: ["one"], row: 0, col: 0 });
    tick(50);
    const second = out[1] ?? "";
    expect(second.startsWith("\x1b[2A")).toBe(false); // cursor was already at the region's top row
    expect(second).toContain("\x1b[J"); // and cleared the rest of the screen
  });

  test("4. a taller frame rewrites from the same spot", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["one"], row: 0, col: 3 });
    tick(50);
    renderer.update({ lines: ["one", "two"], row: 1, col: 0 });
    tick(50);
    expect(out[1]?.startsWith("\x1b[1A")).toBe(false); // only one row was on screen
    expect(out[1]).toContain("\x1b[2K\rtwo");
    expect(out[1]?.endsWith("\x1b[1G")).toBe(true);
  });

  test("5. printAbove moves the live region out of the way and redraws it below", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["live one", "live two"], row: 1, col: 2 });
    tick(50);
    renderer.printAbove("final answer");
    const printed = out.join("");
    // Erased the two live rows, printed the answer, then repainted the region underneath.
    expect(printed).toContain("\x1b[1A"); // up to the top of the live region
    expect(printed).toContain("final answer\n");
    // Erased the live rows, printed the answer, then repainted the region below it.
    expect(printed.indexOf("final answer")).toBeLessThan(printed.lastIndexOf("live one"));
    expect(renderer.drawn).toEqual(["live one", "live two"]);
  });

  test("6. printAbove before anything was drawn just prints", () => {
    const { renderer, out } = harness();
    renderer.printAbove("hello");
    expect(out[0]).toBe("hello\n");
  });

  test("7. flush ignores the throttle", () => {
    const out: string[] = [];
    let now = 0;
    const renderer = new Renderer({ write: (t) => out.push(t), now: () => now });
    renderer.update({ lines: ["a"], row: 0, col: 0 });
    renderer.flush();
    renderer.update({ lines: ["b"], row: 0, col: 0 });
    now = 1;
    renderer.flush();
    expect(out).toHaveLength(2);
  });

  test("8. a full-height region repaints from its top without scrolling from the editor row", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: Array.from({ length: 10 }, (_, i) => `row ${i}`), row: 7, col: 2 });
    tick(50);
    renderer.update({ lines: Array.from({ length: 10 }, (_, i) => `row ${i} changed`), row: 7, col: 3 });
    tick(50);
    expect(out[1]?.startsWith("\x1b[7A")).toBe(true);
    expect(out[1]).toContain("row 0 changed");
    expect(out[1]?.endsWith("\x1b[2A\x1b[4G")).toBe(true);
  });
});

describe("tui markdown", () => {
  test("8. bold and inline code are wrapped, plain text is untouched", () => {
    const out = renderMarkdown("a **bold** word and `code` here", { color: false });
    expect(out).toBe("a bold word and code here");
    const colored = renderMarkdown("**b**");
    expect(colored).toBe("\x1b[1mb\x1b[0m");
    expect(renderMarkdown("`x`", { color: false })).toBe("x");
  });

  test("9. an unmatched marker is left alone", () => {
    expect(renderMarkdown("a **dangling", { color: false })).toBe("a **dangling");
    expect(renderMarkdown("a `dangling", { color: false })).toBe("a `dangling");
  });

  test("10. code fences are dimmed and never inline-formatted", () => {
    const out = renderMarkdown(["before", "```ts", "const a = **not bold**;", "```", "after"].join("\n"), {
      color: false,
    });
    expect(out).toBe(["before", "```ts", "const a = **not bold**;", "```", "after"].join("\n"));
    const dim = "\x1b[2m";
    expect(renderMarkdown("```\nx\n```")).toContain(`${dim}x${"\x1b[0m"}`);
  });

  test("11. several markers on one line all render", () => {
    const out = renderMarkdown("**a** `b` **c** `d`", { color: false });
    expect(out).toBe("a b c d");
  });
});
