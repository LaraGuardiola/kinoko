import { expect, test, describe } from "bun:test";
import { App } from "./app.ts";

// The fake streams below pace themselves one frame at a time on purpose: the order is the test.
/* oxlint-disable no-await-in-loop */

const CSI = new RegExp(`^${String.fromCharCode(27)}\\[([0-9;?]*)([A-Za-z])`);
const noop = (): void => undefined;

// These tests need no Agent implementation: a fake one emits the same events, so they check the
// SCREEN a user would get (including the terminal scrollback), in order.

// Minimal VT emulator: text, \r \n, CSI A/B/G/J/K, SGR ignored, scrolling with scrollback.
class VT {
  rows: string[][]; scroll: string[] = []; r = 0; c = 0;
  constructor(public H: number, public W: number) { this.rows = Array.from({ length: H }, () => []); }
  lineFeed() { if (this.r === this.H - 1) { this.scroll.push(this.rows.shift()!.join("").trimEnd()); this.rows.push([]); } else this.r++; }
  write(s: string) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === "\x1b" && s[i + 1] === "[") {
        const m = CSI.exec(s.slice(i))!;
        const n = parseInt(m[1]!.replace("?", "") || "1", 10) || 1; i += m[0].length - 1;
        switch (m[2]) {
          case "A": this.r = Math.max(0, this.r - n); break;
          case "B": this.r = Math.min(this.H - 1, this.r + n); break;
          case "G": this.c = n - 1; break;
          case "J": this.rows[this.r] = this.rows[this.r]!.slice(0, this.c); for (let k = this.r + 1; k < this.H; k++) this.rows[k] = []; break;
          default: break;
        }
        continue;
      }
      if (ch === "\r") { this.c = 0; continue; }
      if (ch === "\n") { this.lineFeed(); continue; }
      if (this.c >= this.W) { this.c = 0; this.lineFeed(); }
      const row = this.rows[this.r]!; while (row.length < this.c) row.push(" "); row[this.c++] = ch;
    }
  }
  screen() { return this.rows.map((r) => r.join("").trimEnd()); }
  all() { return [...this.scroll, ...this.screen()]; }
}


type Emit = (e: Record<string, unknown>) => void;

/** An Agent stand-in: `script` emits events, the App reacts exactly as it does with the real one. */
class FakeAgent {
  state: "idle" | "running" = "idle";
  #h: Array<(e: never) => void> = [];
  constructor(private script: (emit: Emit, wait: () => Promise<void>) => Promise<void>) {}
  on(h: (e: never) => void) { this.#h.push(h); }
  abort() {}
  steer() {}
  followUp() {}
  async compactNow() { return false; }
  async prompt(_text: string) {
    this.state = "running";
    await this.script((e) => { for (const h of this.#h) h(e as never); }, () => new Promise((r) => setTimeout(r, 1)));
    this.state = "idle";
    for (const h of this.#h) h({ type: "run_end", reason: "end" } as never);
  }
}

async function run(script: ConstructorParameters<typeof FakeAgent>[0], rows = 12, cols = 60) {
  const vt = new VT(rows, cols);
  const agent = new FakeAgent(script);
  const app = new App({ agent: agent as never, write: (t) => vt.write(t), model: "m", contextWindow: 1000, viewportRows: rows - 1, viewportCols: cols });
  const timer = setInterval(() => app.render(), 5);
  app.feed("question\r");
  while (app.running) await new Promise((r) => setTimeout(r, 5));
  clearInterval(timer);
  app.render();
  return { vt, text: vt.all().join("\n") };
}

const words = (n: number, tag: string): string[] => Array.from({ length: n }, (_, i) => `${tag}${i} `);
const inOrder = (text: string, marks: string[]): void => {
  let last = -1;
  for (const m of marks) {
    expect(text.split(m).length - 1).toBe(1); // exactly once
    const at = text.indexOf(m);
    expect(at).toBeGreaterThan(last);
    last = at;
  }
};

describe("blocks come out in the order they happened", () => {
  test("thinking -> answer -> thinking -> tool -> answer, each in its own block", async () => {
    const { text } = await run(async (emit, wait) => {
      for (const w of words(5, "think-a-")) { emit({ type: "thinking_delta", delta: w }); await wait(); }
      for (const w of words(4, "ANSWER-1-")) { emit({ type: "message_delta", delta: w }); await wait(); }
      for (const w of words(5, "think-b-")) { emit({ type: "thinking_delta", delta: w }); await wait(); }
      emit({ type: "message_end", message: {} });
      emit({ type: "tool_start", call: { name: "bash", args: { cmd: "ls" } } });
      emit({ type: "tool_output", output: "file" });
      emit({ type: "tool_end" });
      for (const w of words(4, "ANSWER-2-")) { emit({ type: "message_delta", delta: w }); await wait(); }
      emit({ type: "message_end", message: {} });
    });
    inOrder(text, ["question", "think-a-0", "ANSWER-1-0", "think-b-0", "● bash", "ANSWER-2-0"]);
  });

  test("two messages of one run are separate blocks, not concatenated", async () => {
    const { text } = await run(async (emit) => {
      emit({ type: "message_delta", delta: "first message" });
      emit({ type: "message_end", message: {} });
      emit({ type: "message_delta", delta: "second message" });
      emit({ type: "message_end", message: {} });
    });
    expect(text).not.toContain("first messagesecond message");
    inOrder(text, ["first message", "second message"]);
  });

  test("a block is separated from the next by one blank row", async () => {
    const { text } = await run(async (emit) => {
      emit({ type: "thinking_delta", delta: "pondering" });
      emit({ type: "message_delta", delta: "result" });
      emit({ type: "message_end", message: {} });
    });
    expect(text).toContain("pondering\n\n result");
  });

  test("a long answer in a short terminal is fully reachable in the scrollback, once", async () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `PARA-${i} ${"lorem ipsum ".repeat(9)}`);
    const code = ["```ts", ...Array.from({ length: 25 }, (_, i) => `const v${i} = **${i}**;`), "```"];
    const body = `${paragraphs.join("\n\n")}\n\n${code.join("\n")}\n\nTHE-END\n`;
    const { vt, text } = await run(async (emit, wait) => {
      for (let i = 0; i < body.length; i += 9) { emit({ type: "message_delta", delta: body.slice(i, i + 9) }); if (i % 90 === 0) await wait(); }
      emit({ type: "message_end", message: {} });
    });
    expect(vt.scroll.length).toBeGreaterThan(40); // it really scrolled
    inOrder(text, ["PARA-0 ", "PARA-5 ", "PARA-11 ", "const v0 = **0**;", "const v24 = **24**;", "THE-END"]);
  });

  test("a steer typed mid-stream lands between what was already streamed and what comes next", async () => {
    const vt = new VT(14, 60);
    let release: () => void = noop;
    const gate = new Promise<void>((r) => { release = r; });
    const agent = new FakeAgent(async (emit) => {
      emit({ type: "message_delta", delta: "BEFORE-STEER" });
      await gate;
      emit({ type: "message_delta", delta: "AFTER-STEER" });
      emit({ type: "message_end", message: {} });
    });
    (agent as unknown as { steer: (t: string) => void }).steer = () => undefined;
    const app = new App({ agent: agent as never, write: (t) => vt.write(t), model: "m", contextWindow: 1000, viewportRows: 13, viewportCols: 60 });
    app.feed("go\r");
    await new Promise((r) => setTimeout(r, 10));
    app.feed("use rg instead\r");
    release();
    await new Promise((r) => setTimeout(r, 20));
    app.render();
    inOrder(vt.all().join("\n"), ["go", "BEFORE-STEER", "use rg instead", "AFTER-STEER"]);
  });
});
