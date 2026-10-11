import { expect, test, describe } from "bun:test";
import { Renderer, reflowedUp } from "../../tui/render.ts";

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

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

describe("tui renderer", () => {
  test("1. draws the live region with relative moves and parks the cursor on the editor row", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["thinking...", "> draft"], row: 1, col: 6 });
    expect(tick(50)).toBe(true);
    // No absolute positioning anywhere: the terminal is free to scroll.
    expect(out[0]).toBe(`${SYNC_ON}\r\x1b[J thinking...\r\n > draft\x1b[8G${SYNC_OFF}`);
    expect(out[0]).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[\\d+;\\d+H`));
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
    renderer.update({ lines: ["same"], row: 0, col: 0 });
    expect(tick(1)).toBe(false);
    expect(tick(40)).toBe(false);
    expect(out).toHaveLength(1);
    renderer.update({ lines: ["changed"], row: 0, col: 0 });
    expect(tick(40)).toBe(true);
    expect(out).toHaveLength(2);
  });

  test("3. a repaint first walks back up to the top of the previous region", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["one", "two", "three"], row: 2, col: 0 });
    tick(50);
    renderer.update({ lines: ["one"], row: 0, col: 0 });
    tick(50);
    // The cursor was left on row 2 (the editor): two rows up, column 1, clear to the end.
    expect(out[1]?.startsWith(`${SYNC_ON}\x1b[2A\r\x1b[J`)).toBe(true);
  });

  test("4. a taller frame rewrites from the top of the same region", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["one"], row: 0, col: 3 });
    tick(50);
    renderer.update({ lines: ["one", "two"], row: 1, col: 0 });
    tick(50);
    expect(out[1]?.startsWith(`${SYNC_ON}\r\x1b[J one\r\n two`)).toBe(true);
    expect(out[1]?.endsWith(`\x1b[2G${SYNC_OFF}`)).toBe(true);
  });

  test("5. printAbove writes where the region started and repaints the region below it", () => {
    const { renderer, out, tick } = harness();
    renderer.update({ lines: ["live one", "live two"], row: 1, col: 2 });
    tick(50);
    renderer.printAbove("final answer");
    const printed = out[1] ?? "";
    // Up to the top of the region, wipe it, print the text, then the region again underneath.
    expect(printed.startsWith(`${SYNC_ON}\x1b[1A\r\x1b[J final answer\r\n live one\r\n live two`)).toBe(true);
    expect(printed.indexOf("final answer")).toBeLessThan(printed.indexOf("live one"));
    expect(renderer.drawn).toEqual(["live one", "live two"]);
  });

  test("6. printAbove before anything was drawn just prints", () => {
    const { renderer, out } = harness();
    renderer.printAbove("hello");
    expect(out[0]).toBe(`${SYNC_ON}\r\x1b[J hello\r\n${SYNC_OFF}`);
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

  test("8. printAbove wraps the text to the current terminal width", () => {
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => 8 });
    renderer.printAbove("abcdefghijk");
    expect(out[0]).toContain(" abcdef\r\n ghijk\r\n");
  });

  test("9. wrapped rows keep their style on every row", () => {
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => 8 });
    renderer.printAbove("\x1b[2mabcdefghijk\x1b[0m");
    expect(out[0]).toContain(" \x1b[2mabcdef\x1b[0m\r\n \x1b[2mghijk\x1b[0m\r\n");
  });

  test("10. two printAbove in a row never walk up into the text printed before", () => {
    const { renderer, out } = harness();
    renderer.update({ lines: ["a", "b"], row: 1, col: 0 });
    renderer.flush();
    renderer.printAbove("one");
    renderer.printAbove("two");
    // After the first print the region is repainted with the cursor on its row 1; the second
    // print goes up exactly that far (1 row), which is the region's top, not into "one".
    expect(out[2]?.startsWith(`${SYNC_ON}\x1b[1A\r\x1b[J two`)).toBe(true);
  });

  test("11. release leaves the cursor under the region", () => {
    const { renderer, out } = harness();
    renderer.update({ lines: ["a", "b", "c"], row: 0, col: 0 });
    renderer.flush();
    renderer.release();
    expect(out[1]).toBe("\x1b[2B\r\n\x1b[?25h");
  });

  test("8. after the window got narrower, the way up counts the rows the terminal re-wrapped", () => {
    // Rows of 40 columns (plus the margin) in a terminal now 20 wide: 3 rows each.
    const wide = "x".repeat(40);
    expect(reflowedUp([wide, wide, "short"], 2, 0, 20)).toBe(6);
    expect(reflowedUp([wide, "short"], 1, 30, 20)).toBe(4); // the cursor is on its row's second part
    let cols = 80;
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => cols, now: () => 1000 });
    renderer.update({ lines: [wide, wide, "> "], row: 2, col: 2 });
    renderer.flush();
    cols = 20; // the user tiled the window to a quarter
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    expect(out[1]).toStartWith(`${SYNC_ON}\x1b[6A\r\x1b[J`); // not just the 2 rows that were drawn
    cols = 80; // wider again: nothing was re-wrapped, the plain way up
    renderer.update({ lines: ["a", "> "], row: 1, col: 2 });
    renderer.flush();
    expect(out[2]).toStartWith(`${SYNC_ON}\r\x1b[J`);
  });

  test("9. the side column: from the screen's top row down beside the upper rows, once the position is known", () => {
    const out: string[] = [];
    let cols = 60;
    let rows = 20;
    const renderer = new Renderer({ write: (t) => out.push(t), columns: () => cols, rows: () => rows, now: () => 1000 });
    const side = { col: 41, upper: 2, rows: (h: number) => Array.from({ length: h }, (_, i) => `S${i}`), key: "k", text: 36 };
    const state = { lines: ["stream", "", "rule", "> ", "status"], row: 3, col: 2, side };
    renderer.update(state);
    renderer.flush();
    expect(out[0]).not.toContain("S0"); // where the region is on the screen is not known yet
    renderer.position(14); // the editor row (3) is on screen row 14: the region starts on row 11
    renderer.update({ ...state, side: { ...side, key: "k2" } });
    renderer.flush();
    const frame = out.at(-1)!;
    expect(frame).toContain("\x1b[1;41HS0"); // the column's first row: the screen's top
    expect(frame).toContain("\x1b[12;41HS11"); // its last: beside the blank row above the rule (11 + 2 - 1)
    expect(frame).not.toContain("S12");
    expect(frame.endsWith("\x1b[14;4H\x1b[?2026l")).toBe(true); // the cursor back on the editor row

    // Printing above: the column is erased first, so the rows that scroll away carry none of it.
    renderer.printAbove("a long line of transcript text that wraps at the column");
    const print = out.at(-1)!;
    expect(print.indexOf("\x1b[1;41H\x1b[K")).toBeLessThan(print.indexOf("a long line"));
    expect(print).toContain(" a long line of transcript text that \r\n wraps at the column"); // 36 columns beside it
    expect(print).toContain("\x1b[16;4H"); // two rows printed: the region, and the cursor, two rows lower

    // The window resized under it: the screen again from the top, from what was printed.
    cols = 50;
    rows = 18;
    renderer.flush();
    const redraw = out.at(-1)!;
    expect(redraw).toContain("\x1b[H\x1b[2J");
    expect(redraw).toContain("a long line of transcript text");
  });
});

test("clear: screen and scrollback wiped, the region painted from the top, nothing old redrawn", () => {
  const out: string[] = [];
  const renderer = new Renderer({ write: (t) => out.push(t), columns: () => 40, rows: () => 10, now: () => 1000 });
  renderer.update({ lines: ["> input"], row: 0, col: 2 });
  renderer.printAbove("an old line");
  out.length = 0;
  renderer.clear();
  const written = out.join("");
  expect(written).toContain("\x1b[H\x1b[2J\x1b[3J");
  expect(written).toContain("> input");
  expect(written).not.toContain("an old line");
});

describe("what a click lands on", () => {
  test("rowAt: the printed rows above the region, the region's rows, margin included; nothing before the terminal says where", () => {
    const { renderer } = harness();
    renderer.update({ lines: ["editor", "status"], row: 0, col: 0 });
    renderer.flush();
    renderer.printAbove("one\ntwo");
    expect(renderer.rowAt(1)).toBeUndefined();
    renderer.position(10); // the cursor (on the editor row) is on screen row 10: the region starts there
    expect([renderer.rowAt(8), renderer.rowAt(9), renderer.rowAt(10), renderer.rowAt(11)]).toEqual([" one", " two", " editor", " status"]);
    expect(renderer.rowAt(12)).toBeUndefined();
    renderer.clear();
    expect(renderer.rowAt(9)).toBeUndefined();
  });
});
