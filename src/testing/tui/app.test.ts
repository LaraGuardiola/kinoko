import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { App } from "../../tui/app.ts";
import type { ModelsHost } from "../../tui/app.ts";
import type { ChangesSource } from "../../tui/side.ts";
import type { SavedModel } from "../../config.ts";
import type { Served } from "../../providers/openai-compat.ts";
import { Agent } from "../../loop.ts";
import { Session } from "../../session.ts";
import type { Image, ProviderRequest, StreamEvent, Tool } from "../../types.ts";

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

type ProviderLike = {
  stream: (req: ProviderRequest) => AsyncIterable<StreamEvent>;
  models?: (signal: AbortSignal) => Promise<string[]>;
};

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
  /** Every request the fake engine received, as sent. */
  calls: () => ProviderRequest[];
  press: (chunk: string) => void;
  /** The text a user would see, with ANSI stripped. */
  screen: () => string;
  session: Session;
}

async function harness(
  turns: StreamEvent[][],
  opts: {
    tools?: Tool[];
    model?: string;
    pace?: number;
    viewportRows?: number;
    viewportCols?: number;
    place?: () => Promise<string>;
    /** What the fake engine answers to "which models do you serve". */
    models?: string[];
    budgets?: boolean;
    thinkingProfile?: string;
    modelsHost?: ModelsHost;
    clipboard?: (signal: AbortSignal) => Promise<Image | string>;
    changes?: ChangesSource;
  } = {},
): Promise<Harness> {
  const out: string[] = [];
  const { provider, calls } = scripted(turns, opts.pace ?? 1);
  const served = opts.models;
  if (served) provider.models = async () => served;
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
    retryMs: 1,
  });
  const app = new App({
    agent: agent,
    write: (text) => out.push(text),
    model: opts.model ?? "test-model",
    contextWindow: 1000,
    viewportRows: opts.viewportRows,
    viewportCols: opts.viewportCols,
    place: opts.place,
    budgets: opts.budgets,
    thinkingProfile: opts.thinkingProfile,
    thinking: "LOW · 2048",
    models: opts.modelsHost,
    session: session,
    rebuild: () => agent,
    clipboard: opts.clipboard,
    changes: opts.changes ?? (async () => []), // never the real git
    cwd: ROOT,
  });
  return {
    app: app,
    agent: agent,
    out: out,
    calls: calls,
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
      { model: "/home/u/Downloads/qwen-local-Q4_K_M.gguf" },
    );
    h.press("hi\r");
    await settle(h.agent);
    const line = h.app.statusLine;
    expect(line).toContain("IDLE\x1b[2m | \x1b[0mqwen-local-Q4_K_M\x1b[2m"); // the name, not the file path
    expect(line).toContain("1,240/1,000 tok 124%"); // input + output, and how full the window is
    expect(line).toContain("↑ 1,200 ↓ 40"); // sent, generated
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
    expect(h.app.statusLine).toContain("↑ 3,300 ↓ 200");
    // The hit rate stays a session total: 2,100 cached of 3,300 sent.
    expect(h.app.statusLine).toContain("cache 64%");
  });

  test("8f. a tool call shows (pulsing) as soon as its name streams, before its args are done", async () => {
    const h = await harness(
      [
        [
          { type: "tool_pending", name: "bash" },
          { type: "tool_pending", name: "bash", args: { command: "make all" } }, // its first arg is written
          { type: "text", delta: "" }, // the long args: nothing to show but time
          { type: "tool_call", call: { id: "s", name: "bash", args: { command: "make all" } } },
          { type: "done", stop: "tool_use" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", stop: "end" }],
      ],
      { tools: [{ ...slow, name: "bash" }], pace: 40 },
    );
    h.press("go\r");
    await new Promise((r) => setTimeout(r, 60)); // the name and command are out, the call is not
    expect(h.agent.messages.some((m) => m.role === "tool")).toBe(false);
    h.app.render();
    expect(h.screen()).toContain("● bash make all …"); // the command, before the call exists
    await settle(h.agent);
  });

  test("8e. the place line picks up a new repository after the tool call, while the run goes on", async () => {
    let branch = "";
    const { promise: initDone, resolve: ran } = Promise.withResolvers<void>();
    const gitInit: Tool = {
      name: "git_init",
      description: "",
      schema: {},
      run: async () => {
        branch = " (master)";
        ran();
        return "done";
      },
    };
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "g", name: "git_init", args: {} } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "still " }, { type: "text", delta: "working " }, { type: "text", delta: "on it" }, { type: "done", stop: "end" }],
      ],
      { tools: [gitInit], pace: 40, place: async () => `~/p${branch}` },
    );
    h.press("init a repo\r");
    await initDone;
    await new Promise((r) => setTimeout(r, 20)); // the tool returns and the line is re-read
    // The state, not the screen: what reaches the screen also depends on the 33 ms paint throttle.
    expect(h.agent.state).toBe("running"); // the run has not ended yet...
    expect(h.app.place).toBe("~/p (master)"); // ...and the branch is already there
    await settle(h.agent);
  });

  test("8g. a failed run prints the error on a red band, like a failed tool; the marker points at it", async () => {
    const h = await harness([[{ type: "error", message: "HTTP 500: image input is not supported" }, { type: "done", stop: "error" }]]);
    h.press("look\r");
    await settle(h.agent);
    expect(h.app.marker).toBe("Stopped — error");
    const out = h.out.join("");
    expect(out).toContain("\x1b[48;2;50;30;36m"); // the failed-tool red
    expect(h.screen()).toContain("HTTP 500: image input is not supported");
  });

  test("8g2. a dropped connection: the note says it is retrying, then goes when the model answers", async () => {
    const h = await harness([[{ type: "text", delta: "half" }, { type: "error", message: "the connection closed mid-reply", retry: true }, { type: "done", stop: "error" }]]);
    const notes: string[] = [];
    h.agent.on((e) => {
      if (e.type === "retry") notes.push(h.app.marker);
    });
    h.press("go\r");
    await settle(h.agent);
    expect(notes).toEqual(["the connection closed mid-reply · retry 1/3 in 0s"]);
    expect(h.app.marker).toBe("");
    expect(h.screen()).toContain("done");
  });

  test("8h. a resumed session's status line keeps its totals: sent, generated and the cache hit rate", async () => {
    const h = await harness([]);
    h.app.replay(
      [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "a", usage: { input: 1000, output: 100, cacheRead: 0 } },
        { id: "3", role: "user", content: "more" },
        { id: "4", role: "assistant", content: "b", usage: { input: 1400, output: 52, cacheRead: 1100 } },
      ],
      "resumed",
    );
    expect(h.app.statusLine).toContain("1,452/1,000 tok");
    expect(h.app.statusLine).toContain("↑ 2,400 ↓ 152");
    expect(h.app.statusLine).toContain("cache 46%");
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
    h.press("/help\r"); // through the menu: its "help" item runs the command
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("Ctrl-T"); // the keys table
    expect(h.agent.messages).toHaveLength(0); // no run was started
    expect(h.app.editorText).toBe("");

    h.press("/model now\r"); // with an argument the menu is closed: the typed command runs
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("model: test-model");
    expect(h.agent.messages).toHaveLength(0);

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

/** The last full repaint of the live region, ANSI stripped, as rows. */
function frame(h: Harness): string[] {
  const paints = h.out.filter((chunk) => chunk.includes("tok"));
  return (paints.at(-1) ?? "").replace(ANSI, "").split(/\r?\n/).map((row) => row.trim());
}

describe("slash menu", () => {
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";
  const ESC = "\x1b";
  // A lone Esc waits one frame (it could start a sequence): `press` then polls it through.

  test("/ opens it between the rule under the input and the place line; typing narrows it", async () => {
    const h = await harness([], { place: async () => "~/p (main)", viewportRows: 30 });
    await new Promise((r) => setTimeout(r, 5)); // the place line is read asynchronously
    h.press("/");
    await new Promise((r) => setTimeout(r, 40)); // past the paint throttle
    h.app.render();
    let rows = frame(h);
    const rule = rows.lastIndexOf("─".repeat(78));
    expect(rows[rule + 1]).toStartWith("→ thinking");
    expect(rows.indexOf("~/p (main)")).toBeGreaterThan(rows.findIndex((r) => r.startsWith("quit")));
    h.press("th");
    await new Promise((r) => setTimeout(r, 40)); // past the paint throttle
    h.app.render();
    rows = frame(h);
    expect(rows.some((r) => r.startsWith("→ thinking"))).toBe(true);
    expect(rows.some((r) => r.startsWith("models"))).toBe(false);
  });

  test("thinking: pick a profile with the arrows; the next request carries its effort and budget", async () => {
    const h = await harness([[{ type: "text", delta: "ok" }, { type: "done", stop: "end" }]], { budgets: true, thinkingProfile: "low" });
    h.press("/thinking\r");
    expect(h.app.menuPage).toBe("Thinking");
    h.press(DOWN); // low (current) -> medium
    h.press("\r");
    expect(h.app.menuPage).toBeUndefined();
    expect(h.app.editorText).toBe("");
    expect(h.app.marker).toBe("thinking: MEDIUM · 4096 from the next request");
    h.press("go\r");
    await settle(h.agent);
    expect(h.calls()[0]).toMatchObject({ effort: "medium", budget: 4096 });
  });

  test("models: the engine's list loads into the page; the pick is used from the next request", async () => {
    const h = await harness([[{ type: "text", delta: "ok" }, { type: "done", stop: "end" }]], { models: ["alpha", "beta"] });
    h.press("/models\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press(DOWN);
    h.press("\r");
    expect(h.app.statusLine).toContain("beta");
    h.press("go\r");
    await settle(h.agent);
    expect(h.calls()[0]?.model).toBe("beta");
    // The session remembers it, so a resume starts with beta.
    expect((await Session.load(h.session.path)).model?.model).toBe("beta");
  });

  test("Esc on a page goes back to the root; Esc on the root closes it and empties the input", async () => {
    const h = await harness([]);
    h.press("/session\r");
    expect(h.app.menuPage).toBe("Session");
    h.press(ESC);
    expect(h.app.menuPage).toBeUndefined();
    expect(h.app.editorText).toBe("/session"); // the root is back, as it was
    h.press(UP);
    h.press(ESC);
    expect(h.app.editorText).toBe("");
  });

  test("the session page is a table with this session's file and id", async () => {
    const h = await harness([]);
    h.press("/session\r");
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    const text = frame(h).join("\n");
    expect(text).toContain("┌");
    expect(text).toContain(h.session.meta.id);
  });

  test("Esc with the menu open closes the menu and does not abort the run", async () => {
    const h = await harness([[{ type: "text", delta: "a" }, { type: "text", delta: "b" }, { type: "done", stop: "end" }]], { pace: 40 });
    h.press("go\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press("/");
    h.press(ESC);
    expect(h.agent.state).toBe("running");
    expect(h.app.editorText).toBe("");
    await settle(h.agent);
    expect(h.agent.messages.at(-1)?.stop).toBe("end");
  });
});

/** A models host whose other endpoint answers `served`, recording what is connected and saved. */
function host(served: Served[]) {
  const remote = scripted([[{ type: "text", delta: "from the remote" }, { type: "done", stop: "end" }]]);
  const connected: SavedModel[] = [];
  const saved: SavedModel[] = [];
  const models: ModelsHost = {
    endpoint: "http://local:8081/v1",
    saved: [{ model: "test-model", baseUrl: "http://local:8081/v1", apiKey: "" }],
    connect: (entry) => (connected.push(entry), remote.provider as never),
    discover: async () => served,
    save: async (entry) => (saved.push(entry), [entry]),
    remove: async () => [],
    fixed: () => false,
  };
  return { models, connected, saved, remote };
}

/** Opens /models and goes up to its last item, "+ add provider". */
async function toAdd(h: Harness): Promise<void> {
  h.press("/models\r");
  await new Promise((r) => setTimeout(r, 10));
  h.press("\x1b[A"); // up from the first item wraps to the last
  h.press("\r");
}

describe("adding a provider", () => {
  const ESC = "\x1b";

  test("name, endpoint, key, then a model it serves: switched to, saved under its name, used next", async () => {
    const remote = host([{ id: "remote-coder", contextWindow: 64_000 }]);
    const h = await harness([], { models: [], modelsHost: remote.models });
    await toAdd(h);
    expect(h.app.menuPage).toBe("Add provider · 1/4");
    h.press("\r"); // a provider needs a name: nothing typed stays here
    expect(h.app.menuPage).toBe("Add provider · 1/4");
    h.press("llama.cpp\r");
    expect(h.app.menuPage).toBe("Add provider · 2/4");
    h.press("127.0.0.1:9999/v1\r");
    expect(h.app.menuPage).toBe("Add provider · 3/4");
    h.press("sk-secret\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.app.menuPage).toBe("Add provider · 4/4 · 127.0.0.1:9999");
    h.press("\r");
    await new Promise((r) => setTimeout(r, 10));
    const entry = { model: "remote-coder", baseUrl: "http://127.0.0.1:9999/v1", apiKey: "sk-secret", contextWindow: 64_000, label: "llama.cpp" };
    expect(remote.connected).toEqual([entry]);
    expect(remote.saved).toEqual([entry]);
    expect(h.app.statusLine).toContain("remote-coder");
    expect(h.app.statusLine).toContain("/64,000 tok"); // its own context window
    h.press("go\r");
    await settle(h.agent);
    expect(remote.remote.calls()[0]?.model).toBe("remote-coder");
  });

  test("an endpoint that cannot list its models asks for the id instead", async () => {
    const remote = host([]);
    const h = await harness([], { models: [], modelsHost: remote.models });
    await toAdd(h);
    h.press("box\r");
    h.press("box:8080\r");
    h.press("\r"); // no key
    await new Promise((r) => setTimeout(r, 10));
    expect(h.app.menuPage).toBe("Add provider · 4/4 · box:8080");
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    expect(frame(h).join("\n")).toContain("did not list its models"); // it answered, with nothing
    h.press("my-model\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(remote.saved).toEqual([{ model: "my-model", baseUrl: "http://box:8080", apiKey: "", contextWindow: undefined, label: "box" }]);
  });

  test("the key is shown as dots; Esc at any step goes back to the root", async () => {
    const h = await harness([], { models: [], modelsHost: host([]).models });
    await toAdd(h);
    h.press("x\r");
    h.press("x\r");
    h.press("abc");
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    expect(frame(h).some((row) => row.includes("API key  •••"))).toBe(true);
    h.press(ESC);
    expect(h.app.menuPage).toBeUndefined();
    expect(h.app.editorText).toBe("/models"); // back on the root, as it was
  });
});

describe("removing a saved model", () => {
  test("Del arms it (shown in red), Del again removes it; the page stays, redrawn; arrows disarm", async () => {
    const configured: SavedModel = { model: "test-model", baseUrl: "http://local:8081/v1", apiKey: "" };
    const typo: SavedModel = { model: "coder", baseUrl: "http://127.0.0.1:8081/v1", apiKey: "" };
    const removed: SavedModel[] = [];
    const models: ModelsHost = {
      endpoint: configured.baseUrl,
      saved: [configured, typo],
      connect: () => scripted([]).provider as never,
      discover: async () => [],
      save: async () => [configured],
      remove: async (entry) => (removed.push(entry), [configured]),
      fixed: (entry) => entry === configured,
    };
    const h = await harness([], { models: [], modelsHost: models });
    h.press("/models\r");
    await new Promise((r) => setTimeout(r, 10));
    // By provider name: 127.0.0.1:8081 (coder, removable), local:8081 (test-model, configured), + add provider.
    h.press("\x1b[3~"); // Del on the configured one: nothing
    h.press("\x1b[A"); // up to "coder", over the header
    h.press("\x1b[3~");
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    expect(frame(h).some((row) => row.includes("coder") && row.includes("Del again to remove"))).toBe(true);
    h.press("\x1b[A"); // moving away disarms...
    h.press("\x1b[B");
    h.press("\x1b[3~"); // ...so this Del only arms again
    expect(removed).toEqual([]);
    h.press("\x7f"); // Backspace counts as Del too: the second press removes
    await new Promise((r) => setTimeout(r, 10));
    expect(removed).toEqual([typo]);
    expect(h.app.menuPage).toStartWith("Models"); // still on the page, redrawn
    expect(h.app.marker).toBe("removed coder at 127.0.0.1:8081");
  });
});

test("adding a provider at an endpoint where nothing answers says so before asking for an id", async () => {
  const models: ModelsHost = {
    endpoint: "http://local:8081/v1",
    saved: [],
    connect: () => scripted([]).provider as never,
    discover: async () => {
      throw new Error("ECONNREFUSED");
    },
    save: async (entry) => [entry],
    remove: async () => [],
    fixed: () => false,
  };
  const h = await harness([], { models: [], modelsHost: models });
  h.press("/models\r");
  await new Promise((r) => setTimeout(r, 10));
  h.press("\x1b[A\r"); // "+ add provider"
  h.press("local\r");
  h.press("127.0.0.1:8080/v1\r");
  h.press("\r");
  await new Promise((r) => setTimeout(r, 50));
  h.app.render();
  expect(frame(h).join("\n")).toContain("Nothing answered at 127.0.0.1:8080: is its server running?");
});

test("a saved model picked without a known window learns it from its endpoint, and keeps it", async () => {
  const configured: SavedModel = { model: "test-model", baseUrl: "http://local:8081/v1", apiKey: "" };
  const typed: SavedModel = { model: "small", baseUrl: "http://router:8086/v1", apiKey: "" };
  const saved: SavedModel[] = [];
  const models: ModelsHost = {
    endpoint: configured.baseUrl,
    saved: [configured, typed],
    connect: () => scripted([]).provider as never,
    discover: async () => [{ id: "small", contextWindow: 65_536 }],
    save: async (entry) => (saved.push(entry), [configured, entry]),
    remove: async () => [],
    fixed: (entry) => entry === configured,
  };
  const h = await harness([], { models: [], modelsHost: models });
  expect(h.app.statusLine).toContain("/1,000 tok");
  h.press("/models\r");
  await new Promise((r) => setTimeout(r, 10));
  h.press("\x1b[B\r"); // "small"
  await new Promise((r) => setTimeout(r, 10));
  expect(h.app.statusLine).toContain("/65,536 tok");
  expect(saved).toEqual([{ ...typed, contextWindow: 65_536 }]); // the next pick knows it at once
});

/** Clipboard reads and file checks are async: give them a moment. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe("pasted images", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const shot: Image = { mime: "image/png", data: Buffer.from(PNG).toString("base64") };

  test("Ctrl+V puts [Image #N] in the input; on Enter the images go with the prompt", async () => {
    const h = await harness([[{ type: "text", delta: "a cat" }, { type: "done", stop: "end" }]], { clipboard: async () => shot });
    h.press("what is ");
    h.press("\x16");
    await tick();
    h.press("\x1b[118;5u"); // kitty encoding, second image
    await tick();
    expect(h.app.editorText).toBe("what is [Image #1] [Image #2] ");
    h.press("\r");
    await settle(h.agent);
    const sent = h.calls()[0]!.messages.at(-1)!;
    expect(sent.content).toBe("what is [Image #1] [Image #2]");
    expect(sent.images).toEqual([shot, shot]);
  });

  test("a deleted placeholder leaves its image out; a failed read says why above the input", async () => {
    const h = await harness([[{ type: "done", stop: "end" }]], { clipboard: async () => "no image in the clipboard" });
    h.press("\x16");
    await tick();
    expect(h.app.marker).toBe("Image not attached: no image in the clipboard");
    h.press("hi\r");
    await settle(h.agent);
    expect(h.calls()[0]!.messages.at(-1)!.images).toBeUndefined();
  });

  test("a dropped image file becomes a placeholder; a path to nothing stays text", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/drop.png`, PNG);
    const h = await harness([[{ type: "done", stop: "end" }]]);
    h.press(`\x1b[200~'${ROOT}/drop.png'\x1b[201~`);
    await tick();
    h.press("\x1b[200~missing.png\x1b[201~");
    await tick();
    h.press("\r");
    await settle(h.agent);
    const sent = h.calls()[0]!.messages.at(-1)!;
    expect(sent.content).toBe("[Image #1] missing.png");
    expect(sent.images).toEqual([shot]);
  });
});

describe("@ file references", () => {
  test("@ lists the directory under the input; arrows and Enter complete, then Enter sends", async () => {
    mkdirSync(`${ROOT}/refdir/sub`, { recursive: true });
    writeFileSync(`${ROOT}/refdir/notes.md`, "x");
    const h = await harness([[{ type: "done", stop: "end" }]]);
    h.press("check @refdir/");
    await tick();
    h.app.render();
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    const rows = frame(h).join("\n");
    expect(rows).toContain("Files · refdir/");
    expect(rows).toContain("sub/");
    h.press("\x1b[B"); // down to notes.md
    h.press("\r"); // completes, does not send
    expect(h.app.editorText).toBe("check @refdir/notes.md ");
    expect(h.agent.state).toBe("idle");
    h.press("please\r");
    await settle(h.agent);
    expect(h.calls()[0]!.messages.at(-1)!.content).toBe("check @refdir/notes.md please");
  });

  test("Tab opens a directory in place; Esc closes the list and keeps the text", async () => {
    mkdirSync(`${ROOT}/refdir/sub`, { recursive: true });
    const h = await harness([]);
    h.press("@refdir/s");
    await tick();
    h.press("\t");
    expect(h.app.editorText).toBe("@refdir/sub/");
    h.press("\x1b");
    expect(h.app.editorText).toBe("@refdir/sub/");
    h.press("\r"); // closed: Enter sends as usual
    await settle(h.agent);
    expect(h.calls()[0]!.messages.at(-1)!.content).toBe("@refdir/sub/");
  });
});

/** The last repaint once async work (git, the terminal's answers) has landed, ANSI stripped. */
async function paint(h: Harness): Promise<string> {
  await new Promise((r) => setTimeout(r, 40));
  h.app.render();
  return (h.out.findLast((chunk) => chunk.includes("tok")) ?? "").replace(ANSI, "");
}

describe("side panel", () => {
  const WIDE = "\x1b[4;814;1800t\x1b[5;1080;1920t"; // the terminal: a window 94% of the screen
  const HALF = "\x1b[4;814;900t"; // ...then tiled to half of it
  const HERE = "\x1b[24;3R"; // ...and where its cursor is (the region's editor row)
  const todo: Tool = { name: "todo", description: "", schema: {}, readOnly: true, run: async () => "Plan: 1/2 done" };
  const plan = { items: [{ text: "read the loop", status: "done" }, { text: "draw the panel", status: "in_progress" }] };

  test("a column from the screen's top row, once the terminal said where the region is; gone when tiled narrower", async () => {
    // 120 columns: under WIDE_COLS, so nothing until the terminal says how big the screen is.
    const h = await harness([], { viewportCols: 120, viewportRows: 30, changes: async () => [{ path: "src/a.ts", added: 3, removed: 1 }] });
    expect(await paint(h)).not.toContain("Changes");
    h.press(WIDE);
    expect(await paint(h)).not.toContain("Changes"); // wide, but where to draw it is not known yet
    h.press(HERE);
    const shown = await paint(h);
    expect(shown).toContain("Plan");
    expect(shown).toContain("no plan yet");
    expect(shown).toMatch(/src\/a\.ts +\+3 −1/);
    const raw = h.out.findLast((chunk) => chunk.includes("tok")) ?? "";
    expect(raw).toContain(`\x1b[1;${120 - 36}H`); // its first row: the screen's top, the right columns
    h.press(HALF);
    const gone = h.out.findLast((chunk) => chunk.includes("tok")) ?? "";
    expect(gone).toContain(`\x1b[1;${120 - 36}H\x1b[K`); // erased where it was
    expect(await paint(h)).not.toContain("Plan");
    expect(h.app.editorText).toBe(""); // the answers typed nothing
  });

  test("the model's todo calls are the plan, with no block in the transcript; changes are read after each tool", async () => {
    let reads = 0;
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "t1", name: "todo", args: plan } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "on it" }, { type: "done", stop: "end" }],
      ],
      { tools: [todo], viewportCols: 180, viewportRows: 30, changes: async () => (reads++, []) },
    );
    h.press(WIDE + HERE);
    await paint(h);
    const before = reads;
    h.press("go\r");
    await settle(h.agent);
    const shown = await paint(h);
    expect(shown).toContain("✓ read the loop");
    expect(shown).toContain("● draw the panel");
    expect(shown).toMatch(/Plan +1\/2/);
    expect(reads).toBeGreaterThan(before);
    expect(h.screen()).not.toContain("todo 1/2"); // the column shows it: no tool block
  });

  test("a resumed session shows its last plan", async () => {
    const h = await harness([], { viewportCols: 180, viewportRows: 30 });
    h.press(WIDE + HERE);
    h.app.replay(
      [
        { id: "1", role: "user", content: "go" },
        { id: "2", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "todo", args: plan }] },
        { id: "3", role: "tool", content: "Plan: 1/2 done", toolCallId: "t1" },
      ],
      "resumed",
    );
    expect(await paint(h)).toContain("● draw the panel");
  });
});
