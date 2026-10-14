import { expect, test } from "bun:test";
import type { Renderer, RenderState } from "../../tui/render.ts";
import { Scrollback } from "../../tui/scrollback.ts";
import { stripAnsi } from "../../tui/style.ts";

/** A scrollback over a renderer that only remembers what was printed above the region. */
function scrollback(): { back: Scrollback; printed: string[] } {
  const printed: string[] = [];
  const renderer = { update: () => undefined, printAbove: (text: string) => printed.push(stripAnsi(text)) } as unknown as Renderer;
  const back = new Scrollback({ renderer, state: () => ({ lines: [] }) as unknown as RenderState, columns: () => 40 });
  return { back, printed };
}

test("blocks go up in order, a blank row between them but not before the first", () => {
  const { back, printed } = scrollback();
  back.print("system", "first");
  back.print("system", "second");
  expect(printed).toEqual(["first", "\nsecond"]);
  back.cleared();
  back.print("system", "after a clear");
  expect(printed.at(-1)).toBe("after a clear");
});

test("streamed text stays open until another kind of text, or the end, closes it", () => {
  const { back, printed } = scrollback();
  back.append("thinking", "  ");
  expect(back.open).toBeUndefined(); // whitespace alone opens nothing
  back.append("thinking", "let me see");
  expect(back.open?.text).toBe("let me see");
  back.append("assistant", "Done.");
  expect(printed).toHaveLength(1); // the thinking, closed by the answer
  expect(back.open?.kind).toBe("assistant");
  back.closeBlock();
  expect(printed).toHaveLength(2);
  expect(back.open).toBeUndefined();
});

test("while the terminal is the shell's, prints wait, and come out in order once it is back", () => {
  const { back, printed } = scrollback();
  back.print("system", "! ls"); // what goes to the shell is printed first
  back.hold();
  back.print("system", "one");
  expect(back.later(() => printed.push("panel"))).toBe(true);
  back.print("system", "two");
  expect(printed).toEqual(["! ls"]);
  back.release();
  expect(printed).toEqual(["! ls", "\none", "panel", "\ntwo"]);
  expect(back.later(() => undefined)).toBe(false); // back: nothing waits any more
});
