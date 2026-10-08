import { expect, test, describe, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { App } from "./app.ts";
import { Agent } from "../loop.ts";
import { Session } from "../session.ts";
import type { ProviderRequest, StreamEvent, Tool } from "../types.ts";

const ROOT = `${process.cwd()}/.tmp-tui-test-${process.pid}`;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * A scripted provider: each turn yields the events it was given, one chunk at a time, so a test
 * can interleave keystrokes with streaming exactly like a real terminal would.
 */
function scripted(turns: StreamEvent[][], pace = 1): { provider: ProviderLike; calls: () => ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  let turn = 0;
  return {
    calls: () => seen,
    provider: {
      stream: async function* (req: ProviderRequest): AsyncIterable<StreamEvent> {
        seen.push({ ...req, messages: [...req.messages] });
        const events = turns[turn] ?? [{ type: "text", delta: "done" }, { type: "done", stop: "end" as const }];
        turn++;
        for (const ev of events) {
          if (req.signal.aborted) return;
          yield ev;
          // oxlint-disable-next-line no-await-in-loop -- the fake engine streams on purpose
          if (ev.type !== "done") await new Promise((r) => setTimeout(r, pace));
        }
      },
    },
  };
}

type ProviderLike = { stream: (req: ProviderRequest) => AsyncIterable<StreamEvent> };

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** Waits for the agent to go idle, up to ~200ms. */
async function settle(agent: Agent): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- polling is the point
  for (let i = 0; i < 40 && agent.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
}

interface Harness {
  app: App;
  agent: Agent;
  out: string[];
  press: (chunk: string) => void;
  /** The text a user would see, with ANSI stripped. */
  screen: () => string;
  session: Session;
}

async function harness(
  turns: StreamEvent[][],
  opts: { tools?: Tool[]; model?: string; pace?: number; viewportRows?: number; viewportCols?: number } = {},
): Promise<Harness> {
  const out: string[] = [];
  const { provider, calls } = scripted(turns, opts.pace ?? 1);
  // home: ROOT keeps test sessions out of the real ~/.kinoko/sessions.
  const session = await Session.create({ cwd: ROOT, model: opts.model ?? "test-model", home: ROOT });
  const agent = new Agent({
    provider: provider as never,
    model: opts.model ?? "test-model",
    system: "",
    tools: opts.tools ?? [],
    maxTurns: 10,
    maxCost: 100,
    session: session,
  });
  const app = new App({
    agent: agent,
    write: (text) => out.push(text),
    model: opts.model ?? "test-model",
    contextWindow: 1000,
    viewportRows: opts.viewportRows,
    viewportCols: opts.viewportCols,
    session: session,
    rebuild: () => agent,
  });
  void calls;
  return {
    app: app,
    agent: agent,
    out: out,
    // `press` mirrors the real loop: keys go in, and a held-back Esc gets its frame.
    press: (chunk: string) => {
      app.feed(chunk);
      app.pollKeys();
    },
    screen: () => out.join("").replace(ANSI, ""),
    session: session,
  };
}

const slow: Tool = {
  name: "slow",
  description: "",
  schema: {},
  readOnly: false,
  run: async (_args: unknown, ctx: { signal: AbortSignal }) => {
    await new Promise<void>((r) => setTimeout(r, 60));
    if (ctx.signal.aborted) throw new Error("Aborted by user");
    return "tool done";
  },
};

describe("TUI app with the agent", () => {
  test("submitted prompt and completed answer both remain visible in the transcript", async () => {
    const h = await harness([[{ type: "text", delta: "here is the answer" }, { type: "done", stop: "end" }]]);
    h.press("show me\r");
    await settle(h.agent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    h.app.render();
    expect(h.out.join("")).toContain("\x1b[38;5;159mshow me\x1b[0m");
    expect(h.out.join("")).not.toContain("\x1b[48;5");
    // Finished text goes to the scrollback (printed above the region), not into the last repaint.
    expect(h.screen()).toContain("here is the answer");
  });

  test("trimmed chats move to the scrollback instead of being lost", async () => {
    const h = await harness(
      [
        [{ type: "text", delta: "answer one" }, { type: "done", stop: "end" }],
        [{ type: "text", delta: "answer two" }, { type: "done", stop: "end" }],
      ],
      { viewportRows: 6, viewportCols: 40 },
    );
    h.press("first question\r");
    await settle(h.agent);
    h.app.render();
    h.press("second question\r");
    await settle(h.agent);
    h.app.render();
    // The first exchange no longer fits the live region, but it is still
    // reachable by scrolling up: it was printed above exactly once.
    const stripped = h.screen();
    expect(stripped).toContain("first question");
    expect(stripped).toContain("answer one");
    expect(stripped).toContain("second question");
    expect(stripped).toContain("answer two");
    expect(stripped.indexOf("first question")).toBeLessThan(stripped.indexOf("second question"));
    // The flushed row left the live region, so it was printed above exactly once.
    expect(stripped.split("first question")).toHaveLength(2);
  });

  test("1. Enter sends the prompt, Esc aborts within 100ms", async () => {
    const h = await harness(
      [
        [{ type: "text", delta: "working" }, { type: "text", delta: " on" }, { type: "text", delta: " hard" }],
        [{ type: "done", stop: "end" }],
      ],
      { pace: 40 },
    );
    h.press("hello world\r");
    expect(h.app.running).toBe(true);
    expect(h.agent.state).toBe("running");

    await new Promise((r) => setTimeout(r, 10));
    const at = performance.now();
    h.press("\x1b"); // Esc while running
    await settle(h.agent);
    expect(performance.now() - at).toBeLessThan(100);
    expect(h.agent.state).toBe("idle");
    expect(h.app.running).toBe(false);
    expect(h.app.marker).toBe("Interrupted");
  });

  test("2. a partial answer is printed above the region and kept in the editor log", async () => {
    const h = await harness([[{ type: "text", delta: "half an ans" }], [{ type: "done", stop: "end" }]], { pace: 40 });
    h.press("go\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press("\x1b");
    await settle(h.agent);
    expect(h.agent.messages.some((m) => m.content === "half an ans")).toBe(true);
  });

  test("3. Enter while running steers, and it is delivered after the tool batch", async () => {
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "c1", name: "slow", args: {} } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "answer with steer" }, { type: "done", stop: "end" }],
      ],
      { tools: [slow], pace: 30 },
    );
    h.press("do the thing\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press("actually use rg\r"); // steer while the tool runs
    expect(h.app.queued.map((q) => q.kind)).toEqual(["steer"]);
    expect(h.app.queued[0]?.text).toBe("actually use rg");
    // Only the [steer] line shows it for now: the blue user echo waits until it reaches the model.
    const echo = "\x1b[38;5;159mactually use rg";
    expect(h.out.join("")).not.toContain(echo);

    await settle(h.agent);
    expect(h.out.join("").split(echo)).toHaveLength(2); // echoed exactly once, on delivery
    const users = h.agent.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["do the thing", "actually use rg"]);
    // The steer landed after the tool result, not before it.
    const order = h.agent.messages.map((m) => `${m.role}:${m.content.slice(0, 12)}`);
    expect(order.indexOf("tool:tool done")).toBeLessThan(order.findIndex((l) => l.startsWith("user:actually")));
    expect(h.app.queued).toEqual([]);
  });

  test("4. Alt+Enter queues a follow-up, delivered only when the model would stop", async () => {
    const h = await harness(
      [
        [{ type: "text", delta: "first answer" }],
        [{ type: "text", delta: " second" }, { type: "done", stop: "end" }],
      ],
      { pace: 30 },
    );
    h.press("question\r");
    await new Promise((r) => setTimeout(r, 5));
    h.press("restate it"); // type it first
    h.press("\x1b[13;3u"); // then Alt+Enter (kitty protocol), as its own write
    expect(h.app.queued.map((q) => q.kind)).toEqual(["followUp"]);
    expect(h.app.queued[0]?.text).toBe("restate it");

    await settle(h.agent);
    const users = h.agent.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["question", "restate it"]);
    // The follow-up only produced a second turn after the first answer was complete.
    expect(h.agent.messages.filter((m) => m.role === "assistant" && m.content.includes("first answer"))).toHaveLength(1);
    expect(h.agent.messages.at(-1)?.content).toBe(" second");
  });

  test("5. queued messages come back into the editor when the run is aborted", async () => {
    const h = await harness([[{ type: "text", delta: "long think" }], [{ type: "done", stop: "end" }]], { pace: 30 });
    h.press("first\r");
    await new Promise((r) => setTimeout(r, 5));
    h.press("queued one\rqueued two\r");
    expect(h.app.queued).toHaveLength(2);
    expect(h.app.editorText).toBe("");

    h.press("\x1b");
    await settle(h.agent);

    expect(h.app.marker).toContain("queued messages are back");
    expect(h.app.editorText).toBe("queued one\nqueued two");
    expect(h.app.queued).toEqual([]);
  });

  test("6. Alt+Up pulls one queued message back while running", async () => {
    const h = await harness([[{ type: "text", delta: "x" }], [{ type: "done", stop: "end" }]], { pace: 30 });
    h.press("first\r");
    await new Promise((r) => setTimeout(r, 5));
    h.press("alpha\r");
    h.press("beta\r");
    h.press("typing something");
    h.press("\x1b[1;3A"); // Alt+Up pulls the newest queued message back
    expect(h.app.editorText).toBe("beta\ntyping something");
    expect(h.app.queued.map((q) => q.text)).toEqual(["alpha"]);
    h.press("\x1b");
    await settle(h.agent);
  });

  test("7. Ctrl-C: abort, then clear, then quit", async () => {
    const h = await harness([[{ type: "text", delta: "x" }], [{ type: "done", stop: "end" }]], { pace: 30 });
    let quit = false;
    const app = new App({
      agent: h.agent,
      write: () => undefined,
      model: "m",
      contextWindow: 100,
      onQuit: () => {
        quit = true;
      },
    });
    app.feed("go\r");
    await new Promise((r) => setTimeout(r, 5));
    app.feed("\x03"); // running -> abort
    await settle(h.agent);
    expect(h.agent.state).toBe("idle");

    app.feed("draft text"); // idle with text
    app.feed("\x03");
    expect(app.editorText).toBe("");
    app.feed("\x03"); // idle and empty -> quit
    expect(quit).toBe(true);
  });

  test("8. the status line shows the model, usage, cache and the run state", async () => {
    const h = await harness(
      [
        [
          { type: "text", delta: "hi" },
          { type: "done", stop: "end", usage: { input: 1200, output: 40, cacheRead: 300 } },
        ],
      ],
      { model: "qwen-local" },
    );
    h.press("hi\r");
    await settle(h.agent);
    const line = h.app.statusLine;
    expect(line).toContain("qwen-local");
    expect(line).toContain("1,240/1,000 tok 124%"); // input + output, and how full the window is
    expect(line).toContain("40 generated");
    expect(line).toContain("cache 25%");
    expect(line.startsWith("IDLE")).toBe(true); // level with the rows above, no extra margin
    expect(line).not.toContain("\x1b[7m"); // no inverse background on the state
    expect(h.screen()).toContain("IDLE");
  });

  test("8c. context usage is the latest request, not the sum of every tool round", async () => {
    const h = await harness(
      [
        [
          { type: "tool_call", call: { id: "a", name: "read", args: { path: "x" } } },
          { type: "done", stop: "tool_use", usage: { input: 1000, output: 50, cacheRead: 0 } },
        ],
        [
          { type: "tool_call", call: { id: "b", name: "read", args: { path: "y" } } },
          { type: "done", stop: "tool_use", usage: { input: 1100, output: 50, cacheRead: 1000 } },
        ],
        [
          { type: "text", delta: "done" },
          { type: "done", stop: "end", usage: { input: 1200, output: 100, cacheRead: 1100 } },
        ],
      ],
      { tools: [{ name: "read", description: "", schema: {}, run: async () => "content" }] },
    );
    h.press("go\r");
    await settle(h.agent);
    // Before the fix this read 3,450 (1,050 + 1,150 + 1,300) for a 1,300-token conversation.
    expect(h.app.statusLine).toContain("1,300/1,000 tok");
    // Generated is a session total: every round's output, thinking included.
    expect(h.app.statusLine).toContain("200 generated");
    // The hit rate stays a session total: 2,100 cached of 3,300 sent.
    expect(h.app.statusLine).toContain("cache 64%");
  });

  test("8d. the startup panel is followed by a blank row before the first prompt", async () => {
    const h = await harness([]);
    h.app.intro("Ask it to work on a coding task.");
    h.press("hello\r");
    await settle(h.agent);
    expect(h.out.join("").replace(ANSI, "")).toMatch(/ Ask it to work on a coding task\.\r\n[\s\S]*\r \r\n hello\r\n/);
  });

  test("8a. Shift+Enter as Zed/VS Code send it (ESC+CR) adds a line instead of sending", async () => {
    const h = await harness([]);
    h.press("first");
    h.press("\x1b\r");
    h.press("second");
    expect(h.app.editorText).toBe("first\nsecond");
    expect(h.agent.state).toBe("idle");
    h.press("\x1b[13;2u"); // the kitty protocol spelling
    expect(h.app.editorText).toBe("first\nsecond\n");
  });

  test("8b. several tool calls in one turn print as separate bands, a blank row between them", async () => {
    const h = await harness(
      [
        [
          { type: "tool_call", call: { id: "a", name: "read", args: { path: "one.ts" } } },
          { type: "tool_call", call: { id: "b", name: "read", args: { path: "two.ts" } } },
          { type: "done", stop: "tool_use" },
        ],
      ],
      { tools: [{ name: "read", description: "", schema: {}, run: async () => "content" }] },
    );
    h.press("read both\r");
    await settle(h.agent);
    const out = h.out.join("").replace(ANSI, "");
    // The second block is printed starting with a plain blank row, then its band's top padding row.
    expect(out).toMatch(/\r \r\n {20,}\r\n +● read two\.ts/);
  });

  test("9. tool blocks print above the region, and Ctrl-T expands them", async () => {
    const long = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "c1", name: "bash", args: { cmd: "ls" } } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "listed" }, { type: "done", stop: "end" }],
        [{ type: "tool_call", call: { id: "c2", name: "bash", args: { cmd: "ls" } } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "listed again" }, { type: "done", stop: "end" }],
      ],
      {
        tools: [
          {
            name: "bash",
            description: "",
            schema: {},
            run: async () => long,
          },
        ],
      },
    );
    h.press("list\r");
    await settle(h.agent);
    expect(h.screen()).toContain("● bash ls");
    expect(h.screen()).toContain("… 6 more lines (ctrl+t)");

    h.press("\x14"); // ctrl+t, then run again to see the expanded block
    h.press("list again\r");
    await settle(h.agent);
    // The second block was printed expanded; the first stays collapsed in the history above it.
    // Only the first block was collapsed, so the hint appears exactly once.
    const screen = h.screen();
    expect(screen).toContain("line 8");
    expect(screen.split("more lines (ctrl+t)")).toHaveLength(2);
  });

  test("10. an aborted tool says aborted, not a result", async () => {
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "c1", name: "slow", args: {} } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "never" }, { type: "done", stop: "end" }],
      ],
      { tools: [slow], pace: 5 },
    );
    h.press("go\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press("\x1b");
    await settle(h.agent);
    expect(h.screen()).toContain("aborted");
    expect(h.screen()).not.toContain("tool done");
  });

  test("11. slash commands: help, model, fork and an unknown one", async () => {
    const h = await harness([[{ type: "text", delta: "hi" }, { type: "done", stop: "end" }]]);
    h.press("hi\r");
    await settle(h.agent);

    expect(await h.app.command("/help")).toBe(true);
    expect(h.screen()).toContain("Alt+Up");
    expect(await h.app.command("/model")).toBe(true);
    expect(h.screen()).toContain("model: test-model");

    // /fork moves the head back over the newest message of the branch.
    const before = h.session.activeBranch().length;
    expect(await h.app.command("/fork")).toBe(true);
    expect(h.session.activeBranch()).toHaveLength(before - 1);
    expect(await h.app.command("/nope")).toBe(false);
  });

  test("12. a slash command typed in the editor is never sent to the model", async () => {
    const h = await harness([[{ type: "text", delta: "hi" }, { type: "done", stop: "end" }]]);
    h.press("/model\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("model: test-model");
    expect(h.agent.messages).toHaveLength(0); // no run was started
    expect(h.app.editorText).toBe("");

    h.press("/bogus\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("unknown command /bogus");
    expect(h.agent.messages).toHaveLength(0);
  });

  test("13. /compact is a no-op on a short history and compacts a long one", async () => {
    const small = await harness([[{ type: "text", delta: "hi" }, { type: "done", stop: "end" }]]);
    small.press("hi\r");
    await settle(small.agent);
    expect(await small.app.command("/compact")).toBe(true);
    expect(small.app.marker).toBe("nothing to compact yet");

    const big = "x".repeat(90_000); // ~22k tokens, past the verbatim tail budget
    const long = await harness([
      [{ type: "text", delta: big }, { type: "done", stop: "end" }],
      [{ type: "text", delta: "Objective: the long one" }, { type: "done", stop: "end" }],
    ]);
    long.press("go\r");
    await settle(long.agent);
    expect(await long.app.command("/compact")).toBe(true);
    expect(long.app.marker).toContain("compacted");
    // The history is now the summary plus the verbatim tail, not the whole thing.
    const summary = long.agent.messages.find((m) => m.content.includes("Objective: the long one"));
    expect(summary?.content).toStartWith("<compacted_summary>");
  });

  test("14. the editor keeps accepting keys while the model streams", async () => {
    const chunks: StreamEvent[] = [];
    for (let i = 0; i < 6; i++) chunks.push({ type: "text", delta: `chunk${i} ` });
    chunks.push({ type: "done", stop: "end" });
    const h = await harness([chunks], { pace: 20 });
    h.press("question\r");
    // Type while the answer is still arriving; nothing may be dropped or reordered.
    h.press("second line draft");
    expect(h.app.editorText).toBe("second line draft");
    await settle(h.agent);
    expect(h.app.editorText).toBe("second line draft");
    expect(h.agent.messages[0]?.content).toBe("question");
  });
});
