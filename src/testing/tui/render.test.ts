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

  test("8. the way up after a re-wrap counts its rows; any other width redraws the screen from what was printed", () => {
    // Rows of 40 columns (plus the margin) in a terminal now 20 wide: 3 rows each.
    const wide = "x".repeat(40);
    expect(reflowedUp([wide, wide, "short"], 2, 0, 20)).toBe(6);
    expect(reflowedUp([wide, "short"], 1, 30, 20)).toBe(4); // the cursor is on its row's second part
    let cols = 80;
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => cols, now: () => 1000 });
    renderer.update({ lines: [wide, wide, "> "], row: 2, col: 2 });
    renderer.flush();
    cols = 20; // the user tiled the window to a quarter: the screen is drawn again, from the top
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    expect(out[1]).toStartWith(`${SYNC_ON}\x1b[0m\x1b[H\x1b[2J`);
    cols = 80; // wider again: drawn again too
    renderer.update({ lines: ["a", "> "], row: 1, col: 2 });
    renderer.flush();
    expect(out[2]).toStartWith(`${SYNC_ON}\x1b[0m\x1b[H\x1b[2J`);
    renderer.update({ lines: ["b", "> "], row: 1, col: 2 });
    renderer.flush();
    expect(out[3]).toStartWith(`${SYNC_ON}\x1b[1A\r\x1b[J`); // the same width: the plain way up
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

describe("lending the screen to the user's shell", () => {
  test("suspend wipes the region and shows the cursor; after resume the side column waits for the shell's output to scroll away", () => {
    const out: string[] = [];
    const renderer = new Renderer({ write: (t) => out.push(t), columns: () => 60, rows: () => 6, now: () => 1000 });
    const side = { col: 41, upper: 1, rows: (h: number) => Array.from({ length: h }, (_, i) => `S${i}`), key: "k", text: 36 };
    const state = { lines: ["rule", "> ", "status"], row: 1, col: 2, side };
    renderer.update(state);
    renderer.flush();
    renderer.position(4);
    renderer.update({ ...state, side: { ...side, key: "k2" } });
    renderer.flush();
    expect(out.at(-1)).toContain("S0");

    renderer.suspend();
    expect(out.at(-1)).toContain("\x1b[J"); // the region (and the column) wiped
    expect(out.at(-1)).toContain("\x1b[?25h"); // the shell gets a cursor
    renderer.resume();
    renderer.position(5); // the shell printed: the region is lower now
    renderer.update({ ...state, side: { ...side, key: "k3" } });
    renderer.flush();
    expect(out.at(-1)).not.toContain("S0"); // its full-width lines are still on screen

    for (let i = 0; i < 6; i++) renderer.printAbove(`line ${i}`); // a screenful: they scrolled away
    expect(out.at(-1)).toContain("S0");
  });
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

describe("rewriting a printed block (the capabilities lines)", () => {
  test("on screen: its rows are written in place, the cursor put back; what a click lands on follows", () => {
    const { renderer, out } = harness();
    renderer.update({ lines: ["editor"], row: 0, col: 0 });
    renderer.flush();
    renderer.printAbove("panel\nExtensions: a", "capabilities");
    renderer.printAbove("later");
    renderer.position(10); // rows 7, 8: the panel; 9: later; 10: the editor
    out.length = 0;
    expect(renderer.rewrite("capabilities", "panel\nExtensions: a, b")).toBe(true);
    expect(out[0]).toContain("\x1b7");
    expect(out[0]).toContain("\x1b[8;1H\x1b[0m Extensions: a, b");
    expect(out[0]).toContain("\x1b8");
    expect(renderer.rowAt(8)).toBe(" Extensions: a, b");
    expect(renderer.rowAt(9)).toBe(" later");
  });

  test("its row count stays: a line that would wrap further is cut", () => {
    const out: string[] = [];
    const renderer = new Renderer({ write: (t) => out.push(t), columns: () => 22 });
    renderer.update({ lines: ["editor"], row: 0, col: 0 });
    renderer.printAbove("Extensions: a", "capabilities");
    renderer.position(5);
    expect(renderer.rewrite("capabilities", "Extensions: alpha, beta, gamma")).toBe(true);
    expect(renderer.rowAt(4)).toBe(" Extensions: alpha, …"); // cut at a word, as it would wrap
    // More lines than it had (wrapped at another width): each cut, the rows it had kept.
    expect(renderer.rewrite("capabilities", "Extensions: a\nmore")).toBe(true);
    expect(renderer.rowAt(4)).toBe(" Extensions: a");
    expect(renderer.rowAt(5)).toBe(" editor");
  });

  test("scrolled off the screen, unknown, a different line count, or wiped: false", () => {
    const { renderer } = harness();
    renderer.update({ lines: ["editor"], row: 0, col: 0 });
    renderer.printAbove("panel\nExtensions: a", "capabilities");
    expect(renderer.rewrite("capabilities", "panel\nExtensions: b")).toBe(false); // where is it? not said yet
    renderer.position(2); // the panel's first row would be row 0: off the top
    expect(renderer.rewrite("capabilities", "panel\nExtensions: c")).toBe(false);
    expect(renderer.rewrite("nothing", "x")).toBe(false);
    renderer.clear();
    expect(renderer.rewrite("capabilities", "panel\nExtensions: d")).toBe(false);
  });
});

/** A tool band: it fills the text width it is drawn at. */
const band = (w: number): string => "█".repeat(w);

describe("a new width redraws the screen from what was printed", () => {
  test("a piece with a source is drawn again at the new width; one without is rewrapped; a key still rewrites in place", () => {
    let cols = 42;
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => cols, rows: () => 20, now: () => 1000 });
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    renderer.printAbove(band(40), undefined, band);
    renderer.printAbove("plain words that wrap");
    renderer.printAbove("Extensions: a", "capabilities");
    cols = 22; // narrower: the band is 20 wide now, not 40 split in two
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    const narrow = out.at(-1) ?? "";
    expect(narrow).toContain(` ${"█".repeat(20)}\r\n plain words that wra\r\n p\r\n Extensions: a\r\n`); // no source: cut at the width
    expect(narrow).not.toContain("█".repeat(21));
    cols = 62; // wider again: the band is 60, the words on one row
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    const wide = out.at(-1) ?? "";
    expect(wide).toContain(` ${"█".repeat(60)}\r\n plain words that wrap\r\n`);
    // The keyed piece knows where it is after the redraw: rewritten in place.
    expect(renderer.rewrite("capabilities", "Extensions: a, b")).toBe(true);
    expect(renderer.rowAt(renderer.top! - 1)).toBe(" Extensions: a, b");
  });

  test("the scrollback too: wiped and printed whole at the new width, unless something not kinoko's is in it", () => {
    let cols = 42;
    const out: string[] = [];
    const renderer = new Renderer({ write: (text) => out.push(text), columns: () => cols, rows: () => 6, now: () => 1000 });
    renderer.update({ lines: ["> "], row: 0, col: 2 });
    renderer.flush();
    for (let i = 0; i < 10; i++) renderer.printAbove(band(40), undefined, band); // far more than the screen
    cols = 22;
    renderer.flush();
    const whole = out.at(-1) ?? "";
    expect(whole).toContain("\x1b[2J\x1b[3J"); // the terminal's ragged re-wrap goes
    expect(whole.split(` ${"█".repeat(20)}\r\n`).length - 1).toBe(10); // every band, 20 wide
    expect(whole).not.toContain("█".repeat(21));
    // A shell ran in the terminal (!command): its output is not kinoko's to print again.
    renderer.suspend();
    renderer.resume();
    cols = 32;
    renderer.flush();
    const screen = out.at(-1) ?? "";
    expect(screen).not.toContain("\x1b[3J");
    expect(screen.split(` ${"█".repeat(30)}\r\n`).length - 1).toBeLessThan(10); // the screen's rows only
  });
});
