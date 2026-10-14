import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { App } from "../../tui/app.ts";
import { ANSI as STYLE, visibleLength } from "../../tui/style.ts";
import type { AppOptions, ModelsHost } from "../../tui/app.ts";
import { integrationsSummary, readIntegrations, setTelegram } from "../../integrations.ts";
import { ROOT as ROOT_MENU } from "../../tui/menu-pages.ts";
import type { FilesState } from "../../tui/integrations-menu.ts";
import { GOOD_TOKEN, fakeTelegram, said as tgSaid } from "../serve/fake-telegram.ts";
import type { Catalog, Change, Entry } from "../../catalog.ts";
import { EXTENSIONS } from "../../catalog.ts";
import type { ChangesSource } from "../../tui/side.ts";
import type { SavedModel } from "../../config.ts";
import type { Served } from "../../providers/openai-compat.ts";
import { Agent } from "../../loop.ts";
import { Extensions } from "../../ext.ts";
import { Jobs } from "../../jobs.ts";
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
    extensions?: Catalog;
    skills?: Catalog;
    apply?: (kind: "extensions" | "skills", name: string, change: Change) => Promise<string>;
    /** /new: the harness gives it a fresh session and restarts the agent, as main does. */
    newSession?: boolean;
    clipboard?: (signal: AbortSignal) => Promise<Image | string>;
    changes?: ChangesSource;
    /** The loaded extensions (their tool_call hooks), not the /extensions catalog. */
    ext?: Extensions;
    integrations?: AppOptions["integrations"];
    capabilities?: AppOptions["capabilities"];
    jobs?: Jobs;
    extensionCommands?: AppOptions["extensionCommands"];
    noModel?: boolean;
    handOver?: AppOptions["handOver"];
    /** /sessions' R: the harness loads the session and restarts the agent, as main does. */
    resume?: boolean;
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
    extensions: opts.ext,
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
    extensions: opts.extensions,
    skills: opts.skills,
    apply: opts.apply,
    newSession: opts.newSession
      ? async () => {
          const fresh = await Session.create({ cwd: ROOT, model: "test-model", home: ROOT });
          agent.restart(fresh);
          return { session: fresh, intro: "kinoko vTEST\n  Skills: none" };
        }
      : undefined,
    session: session,
    rebuild: () => agent,
    clipboard: opts.clipboard,
    changes: opts.changes ?? (async () => ({ files: [] })), // never the real git
    cwd: ROOT,
    integrations: opts.integrations ?? { home: ROOT, hubRunning: async () => false },
    capabilities: opts.capabilities,
    jobs: opts.jobs,
    extensionCommands: opts.extensionCommands,
    noModel: opts.noModel,
    handOver: opts.handOver,
    resumeSession: opts.resume
      ? async (path) => {
          const loaded = await Session.load(path);
          agent.restart(loaded);
          return { session: loaded, intro: "kinoko vTEST\n  Skills: none" };
        }
      : undefined,
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

  test("2b. a prompt that arrives from the phone (kinoko serve) is shown as the user's, and the run is the terminal's too", async () => {
    const h = await harness([[{ type: "text", delta: "hola" }, { type: "done", stop: "end" }]], { pace: 40 });
    const run = h.agent.prompt("desde el movil"); // what the link's rpc does
    await new Promise((r) => setTimeout(r, 5));
    expect(h.app.running).toBe(true); // Enter now steers, as for a run started here
    await run;
    await settle(h.agent);
    expect(h.screen()).toContain("desde el movil");
    expect(h.app.running).toBe(false);
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
    await settle(h.agent);
    // Taken back for real: the agent never delivers it (it used to arrive anyway).
    const said = h.agent.messages.filter((m) => m.role === "user" && !m.content.startsWith("[kinoko]")).map((m) => m.content);
    expect(said).toEqual(["first", "alpha"]);
  });

  test("6b. Alt+X sends the waiting steer now, cutting the reply; Alt+C takes the queue back to the editor", async () => {
    const h = await harness(
      [
        [{ type: "thinking", delta: "thinking " }, { type: "thinking", delta: "and thinking " }, { type: "thinking", delta: "and more " }, { type: "text", delta: "x" }, { type: "done", stop: "end" }],
        [{ type: "text", delta: "steered" }, { type: "done", stop: "end" }],
      ],
      { pace: 60 },
    );
    h.press("first\r");
    await new Promise((r) => setTimeout(r, 30));
    h.press("use rg\r"); // a steer while it thinks
    h.press("\x1bx"); // Alt+X: now
    await settle(h.agent);
    const users = h.agent.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["first", "use rg"]);
    expect(h.agent.messages.find((m) => m.stop === "aborted")?.thinking).toStartWith("thinking");

    const g = await harness([[{ type: "text", delta: "x" }], [{ type: "done", stop: "end" }]], { pace: 30 });
    g.press("first\r");
    await new Promise((r) => setTimeout(r, 5));
    g.press("one\r");
    g.press("two\r");
    g.press("\x1bc"); // Alt+C: both back, in order
    expect(g.app.editorText).toBe("one\ntwo");
    expect(g.app.queued).toEqual([]);
    await settle(g.agent);
    expect(g.agent.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["first"]);
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

  test("8g. several calls in one reply: a row each as they stream, then the waiting ones stay under the running one", async () => {
    const { promise: release, resolve: go } = Promise.withResolvers<void>();
    const gated = (name: string): Tool => ({ ...slow, name, run: async () => (await release, "ok") });
    const h = await harness(
      [
        [
          { type: "tool_pending", name: "bash", index: 0 },
          { type: "tool_pending", name: "bash", args: { command: "ls" }, index: 0 },
          { type: "tool_pending", name: "read", index: 1 },
          { type: "tool_pending", name: "read", args: { path: "a.ts" }, index: 1 },
          { type: "tool_call", call: { id: "c1", name: "bash", args: { command: "ls" } } },
          { type: "tool_call", call: { id: "c2", name: "read", args: { path: "a.ts" } } },
          { type: "done", stop: "tool_use" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", stop: "end" }],
      ],
      { tools: [gated("bash"), gated("read")], pace: 50 },
    );
    h.press("go\r");
    await new Promise((r) => setTimeout(r, 175)); // both names are out, the second still being written
    h.app.render();
    const rows = (): string[] => h.screen().split("\n").map((l) => l.trim());
    expect(rows()).toContain("● bash ls");
    expect(rows()).toContain("● read …");
    await new Promise((r) => setTimeout(r, 300)); // the reply is over: bash runs, read waits under it
    h.app.render();
    const running = rows().lastIndexOf("● bash ls …"); // the screen holds every frame: the newest
    expect(running).toBeGreaterThanOrEqual(0);
    expect(rows()[running + 1]).toBe("● read a.ts");
    go();
    await settle(h.agent);
    h.app.render();
    // The newest frame (after the one before's status line): no call is left waiting.
    const all = rows();
    const statuses = all.flatMap((r, i) => (/^(RUNNING|READY|IDLE)\b/.test(r) ? [i] : []));
    expect(all.slice(statuses.at(-2) ?? 0).join("\n")).not.toContain("…");
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
    // Esc once the tool runs: a fixed wait raced it on a slow machine (nothing to abort yet).
    const begun = Promise.withResolvers<void>();
    const watched: Tool = { ...slow, run: (args, ctx) => (begun.resolve(), slow.run(args, ctx)) };
    const h = await harness(
      [
        [{ type: "tool_call", call: { id: "c1", name: "slow", args: {} } }, { type: "done", stop: "tool_use" }],
        [{ type: "text", delta: "never" }, { type: "done", stop: "end" }],
      ],
      { tools: [watched], pace: 5 },
    );
    h.press("go\r");
    await begun.promise;
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

  test("12b. an extension's command: in the slash menu, run with its arguments, its answer printed; never the model", async () => {
    const asked: string[] = [];
    const commands = new Map<string, (args: string) => Promise<string>>([
      ["searxng", async (args) => (asked.push(args), `SearXNG: ${args || "status"}`)],
      ["help", async () => "not this one"], // a built-in name keeps its own
      ["broken", async () => Promise.reject(new Error("no docker"))],
    ]);
    const h = await harness([[{ type: "text", delta: "hi" }, { type: "done", stop: "end" }]], {
      extensionCommands: { list: () => [{ name: "searxng", description: "Set up SearXNG" }, { name: "help", description: "x" }], get: (name) => commands.get(name) },
    });
    h.press("/sear");
    await new Promise((r) => setTimeout(r, 40));
    h.app.render();
    expect(h.screen()).toContain("Set up SearXNG"); // listed with what it does
    h.press("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("SearXNG: status");
    h.press("/searxng setup now\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(["", "setup now"]);
    expect(h.screen()).toContain("SearXNG: setup now");
    h.press("/broken\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.screen()).toContain("/broken failed: no docker");
    expect(h.agent.messages).toHaveLength(0);
  });

  test("12c. no model set up: the status says so, a prompt keeps its text and opens /models, never the model", async () => {
    const h = await harness([[{ type: "done", stop: "end" }]], { noModel: true, modelsHost: { endpoint: "", saved: [], connect: () => ({}) as never, discover: async () => [], save: async () => [], remove: async () => [], fixed: () => false } });
    expect(h.app.statusLine).toContain("no model yet");
    h.app.noModelHint();
    expect(h.screen()).toContain("No model set up yet");
    h.press("hola\r");
    await new Promise((r) => setTimeout(r, 10));
    h.app.render();
    expect(h.screen()).toContain("+ add provider");
    expect(h.app.editorText).toBe("hola"); // kept for when a model is there
    expect(h.calls()).toHaveLength(0);
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
    expect(long.app.marker).toMatch(/^compacted · \d+ messages? kept as they were$/);
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
    // The note says it in cream, like the other notes that only inform (no inverse band).
    await until(h, () => h.out.join("").includes("model: beta"));
    const written = h.out.join("");
    expect(written).toContain("\x1b[38;2;238;222;186mmodel: beta");
    expect(written).not.toContain("\x1b[7mmodel: beta");
    h.press("go\r");
    await settle(h.agent);
    expect(h.calls()[0]?.model).toBe("beta");
    // The session remembers it, so a resume starts with beta.
    expect((await Session.load(h.session.path)).model?.model).toBe("beta");
  });

  test("Esc on a page goes back to the root; Esc on the root closes it and empties the input", async () => {
    const h = await harness([]);
    h.press("/sessions\r");
    expect(h.app.menuPage).toBe("Sessions");
    h.press(ESC);
    expect(h.app.menuPage).toBeUndefined();
    expect(h.app.editorText).toBe("/sessions"); // the root is back, as it was
    h.press(UP);
    h.press(ESC);
    expect(h.app.editorText).toBe("");
  });

  test("/sessions: R on a past session resumes it here: its conversation on screen and in the model", async () => {
    const past = await Session.create({ cwd: ROOT, model: "test-model", home: ROOT });
    await past.append({ id: "p1", role: "user", content: "una sesión antigua sobre setas" });
    await past.append({ id: "p2", role: "assistant", content: "las amanitas son rojas" });
    await Bun.sleep(15); // the latest, so the first after the totals
    const h = await harness([], { resume: true });
    h.press("/sessions\r");
    await until(h, () => frame(h).join("\n").includes("una sesión antigua sobre setas"));
    h.press(DOWN);
    h.press("\r");
    expect(h.app.menuPage).toStartWith("Session · ");
    h.press("r");
    await until(h, () => h.app.menuPage === undefined && h.screen().includes("las amanitas son rojas"));
    expect(h.screen()).toContain(`resumed session ${past.meta.id}`);
    expect(h.agent.messages.map((m) => m.content)).toEqual(["una sesión antigua sobre setas", "las amanitas son rojas"]);
    expect(h.app.marker).toBe("resumed: the model has that conversation again");
  });

  test("/sessions: this one first after the totals, marked; Enter shows its numbers, Enter again per tool", async () => {
    const h = await harness([[{ type: "text", delta: "hola" }, { type: "done", stop: "end", usage: { input: 120, output: 7 } }]]);
    h.press("dime algo bonito\r");
    await settle(h.agent);
    h.press("/sessions\r");
    await until(h, () => frame(h).join("\n").includes("dime algo bonito"));
    expect(frame(h).join("\n")).toMatch(/all .*sessions · /);
    h.press(DOWN);
    h.press("\r");
    expect(h.app.menuPage).toBe("Session · this one");
    await paced();
    h.app.render();
    const text = frame(h).join("\n");
    expect(text).toContain("┌");
    expect(text).toContain(h.session.meta.id);
    expect(text).toContain("120 sent, 7 generated");
    h.press("\r");
    expect(h.app.menuPage).toStartWith("Tools · ");
    await paced();
    h.app.render();
    expect(frame(h).join("\n")).toContain("no tools were called");
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

  test("D on a model makes it the default; the page stays, redrawn, and says so", async () => {
    const configured: SavedModel = { model: "test-model", baseUrl: "http://local:8081/v1", apiKey: "" };
    const other: SavedModel = { model: "coder", baseUrl: "http://127.0.0.1:8081/v1", apiKey: "" };
    let current = configured;
    const models: ModelsHost = {
      endpoint: configured.baseUrl,
      saved: [configured, other],
      connect: () => scripted([]).provider as never,
      discover: async () => [],
      save: async () => [configured],
      remove: async () => [configured],
      fixed: (entry) => entry === current,
      setDefault: async (entry) => ((current = entry), [entry, configured]),
    };
    const h = await harness([], { models: [], modelsHost: models });
    h.press("/models\r");
    await new Promise((r) => setTimeout(r, 10));
    h.press("\x1b[A"); // up to "coder"
    h.press("d");
    await new Promise((r) => setTimeout(r, 40));
    expect(current).toBe(other);
    expect(h.app.menuPage).toStartWith("Models");
    expect(h.app.marker).toBe("default: coder at 127.0.0.1:8081, for new sessions");
    h.app.render();
    expect(frame(h).some((row) => row.includes("→") && row.includes("coder") && row.includes("default"))).toBe(true); // still selected
    expect(frame(h).some((row) => row.includes("test-model") && row.includes("default"))).toBe(false);
    expect(h.app.statusLine).toContain("test-model"); // the model in use stays until one is picked
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

test("at start, a model its endpoint does not serve is told, with what it serves; one it does is not", async () => {
  const wrong = await harness([], { models: ["MiniCPM-V-4.7"] });
  await wrong.app.checkModel();
  expect(wrong.screen()).toContain("test-model is not what");
  expect(wrong.screen()).toContain("it serves MiniCPM-V-4.7");
  const right = await harness([], { models: ["test-model"] });
  await right.app.checkModel();
  expect(right.screen()).not.toContain("is not what");
});

test("a model whose endpoint does not tell its window gets the default one, not the last model's", async () => {
  const configured: SavedModel = { model: "test-model", baseUrl: "http://local:8081/v1", apiKey: "" };
  const other: SavedModel = { model: "minicpm", baseUrl: "http://router:8086/v1", apiKey: "" };
  const models: ModelsHost = {
    endpoint: configured.baseUrl,
    saved: [configured, other],
    connect: () => scripted([]).provider as never,
    discover: async () => [{ id: "minicpm" }], // listed, without a window
    save: async () => [configured, other],
    remove: async () => [],
    fixed: (entry) => entry === configured,
  };
  const h = await harness([], { models: [], modelsHost: models });
  expect(h.app.statusLine).toContain("/1,000 tok");
  h.press("/models\r");
  await new Promise((r) => setTimeout(r, 10));
  h.press("\x1b[B\r"); // "minicpm"
  await new Promise((r) => setTimeout(r, 10));
  expect(h.app.statusLine).toContain("/128,000 tok");
  expect(h.app.marker).toBe("model: minicpm (its context window is unknown: 128,000, the default)");
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
    const h = await harness([], { viewportCols: 120, viewportRows: 30, changes: async () => ({ files: [{ path: "src/a.ts", added: 3, removed: 1 }], head: "a1b2c3d" }) });
    expect(await paint(h)).not.toContain("Changes");
    h.press(WIDE);
    expect(await paint(h)).not.toContain("Changes"); // wide, but where to draw it is not known yet
    h.press(HERE);
    const shown = await paint(h);
    expect(shown).toContain("Plan");
    expect(shown).toContain("no plan yet");
    expect(shown).toMatch(/src\/a\.ts +\+3 −1/);
    expect(shown).toMatch(/Changes a1b2c3d/); // the last commit beside the title
    const raw = h.out.findLast((chunk) => chunk.includes("tok")) ?? "";
    expect(raw).toContain(`\x1b[1;${120 - 36}H`); // its first row: the screen's top, the right columns
    h.press(HALF);
    const gone = h.out.findLast((chunk) => chunk.includes("tok")) ?? "";
    expect(gone).toContain("\x1b[H\x1b[2J"); // the screen drawn again at the full width, no column
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
      { tools: [todo], viewportCols: 180, viewportRows: 30, changes: async () => (reads++, { files: [] }) },
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

  test("Ctrl+O unfolds the plan, the arrows scroll it by tasks, Esc folds it; narrow, it prints it", async () => {
    const steps = { items: Array.from({ length: 30 }, (_, i) => ({ text: `step ${i + 1}`, status: i < 3 ? "done" : i === 3 ? "in_progress" : "pending" })) };
    const history = [
      { id: "1", role: "user" as const, content: "go" },
      { id: "2", role: "assistant" as const, content: "", toolCalls: [{ id: "t1", name: "todo", args: steps }] },
      { id: "3", role: "tool" as const, content: "Plan: 3/30 done", toolCallId: "t1" },
    ];
    const h = await harness([], { viewportCols: 180, viewportRows: 30 });
    h.press(WIDE + HERE);
    h.app.replay(history, "resumed");
    expect(await paint(h)).toMatch(/… \d+ more tasks · ctrl\+o/);
    h.press("\x0f"); // Ctrl+O
    const open = await paint(h);
    expect(open).toContain("↑↓ scroll · ctrl+o fold");
    expect(open).toContain("↑ 2 earlier tasks"); // it opens on the task at hand
    h.press("\x1b[B\x1b[B");
    expect(await paint(h)).toContain("↑ 4 earlier tasks");
    h.press("\x1b[A"); // up scrolls back
    expect(await paint(h)).toContain("↑ 3 earlier tasks");
    expect(h.app.editorText).toBe(""); // the arrows went to the plan, not the history
    h.press("\x1b");
    expect(await paint(h)).not.toContain("ctrl+o fold");

    const narrow = await harness([], { viewportCols: 90, viewportRows: 30 });
    narrow.app.replay(history, "resumed");
    narrow.press("\x0f");
    expect(narrow.screen()).toContain("Plan 3/30");
    expect(narrow.screen()).toContain("● step 4");
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

function store(entries: Entry[]): { store: Catalog; installed: string[]; removed: string[]; toggled: string[] } {
  const installed: string[] = [];
  const removed: string[] = [];
  const toggled: string[] = [];
  return {
    installed,
    removed,
    toggled,
    store: {
      enable: async (name, on) => {
        toggled.push(`${name} ${on ? "on" : "off"}`);
        return { ok: true, note: `${name} ${on ? "on" : "off"}` };
      },
      kind: EXTENSIONS,
      repo: "https://github.com/LaraGuardiola/kinoko-extensions.git",
      local: async () => [],
      list: async () => entries.map((e) => ({ ...e })),
      install: async (name) => {
        installed.push(name);
        return { ok: true, note: `${name} installed` };
      },
      remove: async (name) => {
        removed.push(name);
        return { ok: true, note: `${name} removed` };
      },
    },
  };
}

// Frames are paced (the CLI repaints every 33 ms): wait past the pacing, then draw.
const paced = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe("the extensions and skills pages", () => {
  test("with apply, an install takes effect at once and the note says how", async () => {
    const fake = store([{ name: "web", description: "web tools", installed: false }]);
    const applied: string[] = [];
    const apply = async (kind: string, name: string, change: string): Promise<string> => {
      applied.push(`${kind} ${change} ${name}`);
      return "loaded";
    };
    const h = await harness([], { extensions: fake.store, apply, viewportRows: 30 });
    h.press("/extensions\r");
    await paced();
    h.press("\r");
    await paced();
    expect(applied).toEqual(["extensions install web"]);
    expect(h.app.marker).toBe("web installed: loaded");
  });

  test("a shared skill shows as shared and Del leaves it alone", async () => {
    const fake = store([{ name: "omarchy", description: "Omarchy config", installed: true, shared: true }]);
    const h = await harness([], { skills: fake.store, viewportRows: 30 });
    h.press("/skills\r");
    await paced();
    h.app.render();
    expect(h.screen()).toContain("shared · Omarchy config");
    h.press("\x1b[3~");
    h.press("\x1b[3~");
    await paced();
    expect(fake.removed).toEqual([]);
  });

  test("/skills opens its own page from its own catalog", async () => {
    const fake = store([{ name: "write-ext", description: "Write an extension for kinoko", installed: false }]);
    const h = await harness([], { skills: { ...fake.store, repo: "https://github.com/LaraGuardiola/kinoko-skills.git" }, viewportRows: 30 });
    h.press("/skills\r");
    expect(h.app.menuPage).toBe("Skills");
    await paced();
    h.app.render();
    expect(h.screen()).toContain("Write an extension for kinoko");
    h.press("\r");
    await paced();
    expect(fake.installed).toEqual(["write-ext"]);
  });


  test("lists the repository's extensions; Enter installs one, the note says to restart", async () => {
    const fake = store([
      { name: "herdr", description: "herdr agent", installed: true },
      { name: "web", description: "web tools", installed: false },
    ]);
    const h = await harness([], { extensions: fake.store, viewportRows: 30 });
    h.press("/extensions\r");
    expect(h.app.menuPage).toBe("Extensions");
    await paced();
    h.app.render();
    expect(h.screen()).toContain("web tools");
    h.press("\x1b[B"); // down to web
    h.press("\r");
    await paced();
    expect(fake.installed).toEqual(["web"]);
    expect(h.app.marker).toBe("web installed: restart kinoko to apply it"); // no apply: at the next start
  });

  test("the selection stays on the entry switched, so Enter twice switches it off and back on", async () => {
    const fake = store([
      { name: "alpha", description: "a", installed: true, enabled: true },
      { name: "beta", description: "b", installed: true, enabled: true },
      { name: "gamma", description: "c", installed: true, enabled: true },
    ]);
    const h = await harness([], { extensions: fake.store, apply: async () => "done", viewportRows: 30 });
    h.press("/extensions\r");
    await paced();
    h.press("\x1b[B\x1b[B"); // gamma
    h.press("\r");
    await paced();
    h.press("\r");
    await paced();
    expect(fake.toggled).toEqual(["gamma off", "gamma on"]);
  });

  test("Enter switches an installed one off and on, at once and with the page open; U updates it", async () => {
    const fake = store([
      { name: "herdr", description: "herdr agent", installed: true, enabled: true },
      { name: "web", description: "web tools", installed: false },
    ]);
    const applied: string[] = [];
    const apply = async (kind: string, name: string, change: string): Promise<string> => {
      applied.push(`${change} ${name}`);
      return change === "disable" ? "unloaded" : "loaded";
    };
    const h = await harness([], { extensions: fake.store, apply, viewportRows: 30 });
    h.press("/extensions\r");
    await paced();
    h.press("\r"); // herdr: off
    await paced();
    expect(fake.toggled).toEqual(["herdr off"]);
    expect(h.app.marker).toBe("herdr off: unloaded");
    expect(h.app.menuPage).toBe("Extensions"); // still open: switch the next one
    h.app.render();
    expect(h.screen()).toContain("○ off · herdr agent");
    h.press("\r"); // and on again
    await paced();
    expect(fake.toggled).toEqual(["herdr off", "herdr on"]);
    h.press("u"); // fetched again from the repository
    await paced();
    expect(fake.installed).toEqual(["herdr"]);
    h.press("\x1b[B");
    h.press("\r"); // web is not installed: Enter installs it
    await paced();
    expect(fake.installed).toEqual(["herdr", "web"]);
    expect(applied).toEqual(["disable herdr", "enable herdr", "install herdr", "install web"]);
  });

  test("Del twice removes an installed one; a fetch that fails shows why", async () => {
    const fake = store([{ name: "herdr", description: "herdr agent", installed: true }]);
    const h = await harness([], { extensions: fake.store, viewportRows: 30 });
    h.press("/extensions\r");
    await paced();
    h.press("\x1b[3~");
    h.press("\x1b[3~");
    await paced();
    expect(fake.removed).toEqual(["herdr"]);
    expect(h.app.marker).toBe("herdr removed: restart kinoko to apply it");

    const broken = await harness([], {
      viewportRows: 30,
      extensions: { ...fake.store, list: async () => Promise.reject(new Error("could not fetch the repo: offline")) },
    });
    broken.press("/extensions\r");
    await paced();
    broken.app.render();
    expect(broken.screen()).toContain("could not fetch the repo: offline");

    // Offline with something installed: it is still listed, and the hint says why the list is local.
    const offline = await harness([], {
      viewportRows: 30,
      extensions: {
        ...fake.store,
        local: async () => [{ name: "herdr", description: "herdr agent", installed: true }],
        list: async () => Promise.reject(new Error("could not update the repo: offline")),
      },
    });
    offline.press("/extensions\r");
    await paced();
    offline.app.render();
    expect(offline.screen()).toContain("herdr agent");
    expect(offline.screen()).toContain("could not update the repo: offline · showing what is on this computer");
  });
});

describe("the mouse in the menu", () => {
  test("clicks only, until the menu opens: then motion too, and the wheel moves the selection", async () => {
    const h = await harness([], { viewportRows: 30 });
    h.app.render();
    expect(h.out.join("")).not.toContain("\x1b[?1003h");
    expect(h.out.join("")).toContain("\x1b[?1000h\x1b[?1006h");
    h.press("/");
    expect(h.out.join("")).toContain("\x1b[?1003h\x1b[?1006h");
    h.app.handleKey({ name: "mouse", mouse: { x: 1, y: 1, button: 0, press: true, wheel: "down" } });
    await paced();
    h.app.render();
    expect(h.screen()).toContain("→ models");
    h.press("\x1b"); // closed: back to clicks only
    expect(h.out.join("")).toContain("\x1b[?1003l\x1b[?1000h\x1b[?1006h");
  });
});

describe("a click on a code block's mark", () => {
  test("copies that block (OSC 52); a click anywhere else copies nothing", async () => {
    // No clipboard tool: the test must not write to this machine's clipboard.
    const saved = { wayland: process.env.WAYLAND_DISPLAY, display: process.env.DISPLAY };
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    try {
      const reply = "First:\n```ts\nconst a = 1;\n```\nThen:\n```sh\nls -la\n```";
      const h = await harness([[{ type: "text", delta: reply }, { type: "done", stop: "end" }]], { viewportRows: 30, viewportCols: 60 });
      h.press("code please\r");
      await settle(h.agent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      h.app.render();
      h.app.handleKey({ name: "cursor-report", at: { row: 28, col: 1 } });
      const copied = (): string[] => h.out.filter((s) => s.startsWith("\x1b]52;c;")).map((s) => Buffer.from(s.slice(7, -1), "base64").toString());
      const click = (x: number, y: number): void => h.app.handleKey({ name: "mouse", mouse: { x, y, button: 0, press: true } });
      for (let y = 1; y <= 30; y++) for (let x = 1; x <= 60; x++) click(x, y);
      // Each mark has three cells that take a click (it and one either side): both blocks, three times.
      expect(copied().toSorted()).toEqual([...Array(3).fill("const a = 1;"), ...Array(3).fill("ls -la")].toSorted());
      // The note only informs: cream, no inverse background.
      h.app.render();
      await new Promise((resolve) => setTimeout(resolve, 40));
      h.app.render();
      expect(h.out.join("")).toContain(`${STYLE.cream}copied: 1 line${STYLE.reset}`);
      expect(h.out.join("")).not.toContain(`${STYLE.inverse}copied`);
    } finally {
      if (saved.wayland !== undefined) process.env.WAYLAND_DISPLAY = saved.wayland;
      if (saved.display !== undefined) process.env.DISPLAY = saved.display;
    }
  });
});

describe("/clear and /new", () => {
  test("/clear wipes the screen and the scrollback; the conversation stays", async () => {
    const h = await harness([[{ type: "text", delta: "first answer" }, { type: "done", stop: "end" }]]);
    h.press("hello\r");
    await settle(h.agent);
    const before = h.agent.messages.length;
    h.out.length = 0;
    h.press("/clear\r");
    expect(h.out.join("")).toContain("\x1b[2J\x1b[3J");
    expect(h.agent.messages).toHaveLength(before);
  });

  test("/new: a new session, no history, counters at zero, the panel again; refused during a run", async () => {
    const h = await harness([[{ type: "text", delta: "first answer" }, { type: "done", stop: "end", usage: { input: 500, output: 20 } }]], { newSession: true });
    h.press("hello\r");
    await settle(h.agent);
    expect(h.app.statusLine).toContain("520/1,000 tok");
    h.out.length = 0;
    h.press("/new\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.agent.messages).toEqual([]);
    expect(h.app.statusLine).toContain("0/1,000 tok");
    expect(h.app.marker).toBe("new session: the model starts with no history");
    expect(h.screen()).toContain("kinoko vTEST");

    const busy = await harness([[{ type: "text", delta: "slow" }, { type: "text", delta: "er" }, { type: "done", stop: "end" }]], { newSession: true, pace: 30 });
    busy.press("go\r");
    busy.press("/new\r");
    await new Promise((r) => setTimeout(r, 5));
    expect(busy.app.marker).toBe("a run is going: Esc it first, then /new");
    await settle(busy.agent);
  });
});

const sudoCall = (id: string): StreamEvent[] => [{ type: "tool_call", call: { id, name: "bash", args: { command: "sudo ls" } } }, { type: "done", stop: "tool_use" }];
const asking = (): Extensions => {
  const ext = new Extensions(() => undefined);
  ext.on("tool_call", () => ({ ask: true, reason: "sudo needs confirmation" }));
  return ext;
};
/** Waits for a request other than `last` (the one just answered) to show. */
const waiting = async (h: Harness, last?: string): Promise<string> => {
  const shown = (): string | undefined => (h.app.approval?.id === last ? undefined : h.app.approval?.id);
  // oxlint-disable-next-line no-await-in-loop -- polling is the point
  for (let i = 0; i < 100 && shown() === undefined; i++) await new Promise((r) => setTimeout(r, 2));
  return shown() ?? "";
};


describe("approvals", () => {
  const ran: string[] = [];
  const bash: Tool = {
    name: "bash",
    description: "",
    schema: {},
    readOnly: false,
    run: async (args: unknown) => {
      ran.push(String((args as { command: string }).command));
      return "ran";
    },
  } as unknown as Tool;
  test("the prompt shows the command and the keys; y allows, n denies", async () => {
    ran.length = 0;
    const h = await harness([sudoCall("c1"), sudoCall("c2")], { tools: [bash], ext: asking(), viewportRows: 30 });
    h.press("go\r");
    const first = await waiting(h);
    await new Promise((r) => setTimeout(r, 40)); // past the paint throttle
    h.app.render();
    const rows = frame(h);
    expect(rows).toContain("🔐 sudo needs confirmation");
    expect(rows).toContain("$ sudo ls");
    expect(rows).toContain("y allow · n deny · a allow for this session · esc deny");
    h.press("y");
    await tick();
    expect(h.app.approval?.id).not.toBe(first);
    await waiting(h, first);
    h.press("n");
    await settle(h.agent);
    expect(ran).toEqual(["sudo ls"]);
    expect(h.agent.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["ran", "ERROR: denied by the user: it did not run"]);
    expect(h.app.editorText).toBe(""); // the answers never reached the editor
  });

  test("a allows for the session; Esc denies without aborting the run", async () => {
    ran.length = 0;
    const h = await harness([sudoCall("c1"), sudoCall("c2"), [{ type: "tool_call", call: { id: "c3", name: "bash", args: { command: "sudo pwd" } } }, { type: "done", stop: "tool_use" }]], { tools: [bash], ext: asking() });
    h.press("go\r");
    const first = await waiting(h);
    h.press("a");
    await waiting(h, first); // c2 is the same command: not asked; c3 is
    expect(ran).toEqual(["sudo ls", "sudo ls"]);
    h.press("\x1b");
    await settle(h.agent);
    expect(h.agent.messages.at(-1)?.content).toBe("done"); // the run went on to its end
    expect(h.agent.messages.findLast((m) => m.role === "tool")?.content).toBe("ERROR: denied by the user: it did not run");
  });

  test("answered elsewhere: the prompt goes and a note says who", async () => {
    const h = await harness([sudoCall("c1")], { tools: [bash], ext: asking() });
    h.press("go\r");
    await waiting(h);
    h.agent.approve(h.app.approval?.id ?? "", true, { by: "telegram" });
    await tick();
    expect(h.app.approval).toBeUndefined();
    expect(h.app.marker).toBe("allowed from Telegram");
    await settle(h.agent);
  });
});

/** Waits for `check`, repainting as the render timer would. */
const until = async (h: Harness, check: () => boolean): Promise<void> => {
  for (let i = 0; i < 150 && !check(); i++) {
    // oxlint-disable-next-line no-await-in-loop -- polling is the point
    await new Promise((r) => setTimeout(r, 10));
    h.app.render();
  }
  expect(check()).toBe(true);
};

describe("/integrations: Telegram's setup", () => {

  test("create the bot, a wrong token then the right one, pairing with the code, the options, disconnect", async () => {
    const tg = fakeTelegram();
    const home = `${ROOT}/integrations-home`;
    try {
      const h = await harness([], { integrations: { home, apiBase: tg.base, hubRunning: async () => true }, viewportRows: 40 });
      h.press("/integrations\r");
      await until(h, () => h.app.menuPage === "Integrations" && frame(h).join("\n").includes("Not set up"));
      h.press("\r");
      expect(h.app.menuPage).toBe("Telegram · 1/3 · create the bot");
      h.press("\r");
      expect(h.app.menuPage).toBe("Telegram · 2/3 · the token");
      h.press("999:bad\r");
      await until(h, () => h.screen().includes("not valid"));
      expect(h.app.menuPage).toBe("Telegram · 2/3 · the token");
      expect(h.screen()).not.toContain("999:bad"); // a secret page shows dots
      h.press(`${GOOD_TOKEN}\r`);
      await until(h, () => h.app.menuPage === "Telegram · 3/3 · pair your chat");
      expect((await readIntegrations(home)).telegram).toMatchObject({ token: GOOD_TOKEN, bot: "kinoko_test_bot", on: true });
      await new Promise((r) => setTimeout(r, 60)); // past the paint throttle
      h.app.render();
      const code = /\/start (\d{6})/.exec(frame(h).join("\n"))?.[1] ?? "";
      expect(code).toMatch(/^\d{6}$/);
      await new Promise((r) => setTimeout(r, 50)); // the wait has taken the updates already there
      tg.push(tgSaid(`/start ${code}`, 4242));
      await until(h, () => h.app.menuPage === "Telegram · @kinoko_test_bot · Lara");
      expect((await readIntegrations(home)).telegram).toMatchObject({ chat: 4242, name: "Lara" });
      expect(tg.calls.find((c) => c.method === "sendMessage")?.body).toMatchObject({ chat_id: 4242 });
      expect(h.app.marker).toBe("Telegram: paired with Lara");

      // Options: notify is the second item; Enter switches it off and the page stays.
      h.press("\x1b[B\r");
      await until(h, () => frame(h).join("\n").includes("notify"));
      await until(h, () => h.app.menuPage !== undefined);
      await new Promise((r) => setTimeout(r, 50));
      expect((await readIntegrations(home)).telegram?.notify).toBe(false);
      expect(h.app.menuPage).toBe("Telegram · @kinoko_test_bot · Lara");
      // Disconnect: the last item, Del twice.
      for (let i = 0; i < 4; i++) h.press("\x1b[B");
      h.press("\x7f");
      h.press("\x7f");
      await until(h, () => h.app.menuPage === "Integrations");
      expect((await readIntegrations(home)).telegram).toBeUndefined();
    } finally {
      tg.stop();
    }
  });

  test("Esc on the pairing page stops the wait", async () => {
    const tg = fakeTelegram();
    const home = `${ROOT}/integrations-esc`;
    try {
      const h = await harness([], { integrations: { home, apiBase: tg.base, hubRunning: async () => false } });
      h.press("/integrations\r");
      await until(h, () => h.screen().includes("Not set up"));
      h.press("\r\r");
      h.press(`${GOOD_TOKEN}\r`);
      await until(h, () => h.app.menuPage === "Telegram · 3/3 · pair your chat");
      await new Promise((r) => setTimeout(r, 50));
      const polls = (): number => tg.calls.filter((c) => c.method === "getUpdates").length;
      h.press("\x1b");
      expect(h.app.menuPage).toBeUndefined();
      const after = polls();
      await new Promise((r) => setTimeout(r, 400));
      expect(polls()).toBe(after); // no more polling
    } finally {
      tg.stop();
    }
  });

  test("files: the telegram extension's state; Enter installs it and the item turns on", async () => {
    const home = `${ROOT}/integrations-files`;
    await setTelegram(home, () => ({ token: GOOD_TOKEN, bot: "kinoko_test_bot", chat: 1, name: "Lara", notify: true, prompts: true, approvals: true, on: true }));
    let state: FilesState = "missing";
    let installs = 0;
    const filesExtension = { state: async () => state, turnOn: async () => (installs++, (state = "on"), "telegram installed: loaded") };
    const h = await harness([], { integrations: { home, hubRunning: async () => false, filesExtension } });
    h.press("/integrations\r");
    await until(h, () => h.screen().includes("@kinoko_test_bot with Lara"));
    h.press("\r");
    await until(h, () => frame(h).join("\n").includes("Enter installs the telegram extension"));
    for (let i = 0; i < 4; i++) h.press("\x1b[B");
    h.press("\r");
    await until(h, () => frame(h).join("\n").includes("The model can send you files"));
    expect(installs).toBe(1);
    expect(h.app.marker).toBe("telegram installed: loaded");
    expect(h.app.menuPage).toBe("Telegram · @kinoko_test_bot · Lara");
  });
});

/** A startup panel with these extensions. */
const panel = (extensions: string): string => `kinoko vTEST\n\n[Capabilities]\n  Skills: none\n  Extensions: ${extensions}\n\nAsk it to work.`;

describe("the [Capabilities] lines follow what is installed", () => {

  test("on screen: rewritten in place when an extension is installed, nothing printed again", async () => {
    const fake = store([{ name: "web", description: "web tools", installed: false }]);
    let on = "none";
    const apply = async (): Promise<string> => ((on = "web"), "loaded");
    const h = await harness([], { extensions: fake.store, apply, capabilities: async () => panel(on), viewportRows: 30 });
    h.app.intro(panel("none"));
    h.app.handleKey({ name: "cursor-report", at: { row: 20, col: 1 } }); // the terminal says where the region is
    h.out.length = 0;
    h.press("/extensions\r");
    await paced();
    h.press("\r");
    await paced();
    const written = h.out.join("");
    expect(written).toContain("\x1b7");
    expect(written).toContain(" Extensions: web");
    const count = (): number => h.out.join("").split("[Capabilities]").length;
    const rewritten = count();
    h.press("\x1b");
    h.press("\x1b");
    expect(count()).toBe(rewritten); // closing the menu prints nothing again
  });

  test("scrolled away: printed again, once, when the menu closes", async () => {
    const fake = store([{ name: "web", description: "web tools", installed: false }]);
    let on = "none";
    const apply = async (): Promise<string> => ((on = "web"), "loaded");
    const h = await harness([], { extensions: fake.store, apply, capabilities: async () => panel(on), viewportRows: 30 });
    h.app.intro(panel("none")); // the terminal never said where: as good as off screen
    h.press("/extensions\r");
    await paced();
    h.press("\r");
    await paced();
    const before = h.screen().split("[Capabilities]").length;
    h.press("\x1b");
    h.press("\x1b");
    const after = h.screen();
    expect(after.split("[Capabilities]").length).toBe(before + 1);
    expect(after.slice(after.lastIndexOf("[Capabilities]"))).toContain("Extensions: web");
    h.press("/extensions\r");
    h.press("\x1b");
    h.press("\x1b");
    expect(h.screen().split("[Capabilities]").length).toBe(before + 1); // nothing new: not again
  });
});

describe("the [Capabilities] lines follow /integrations", () => {
  test("switching the bot off in /integrations rewrites the Integrations line", async () => {
    const home = `${ROOT}/integrations-capabilities`;
    await setTelegram(home, () => ({ token: GOOD_TOKEN, bot: "kinoko_test_bot", chat: 1, name: "Lara", notify: true, prompts: true, approvals: true, on: true }));
    const line = async (): Promise<string> => `kinoko vTEST\n\n[Capabilities]\n  Skills: none\n  Integrations: ${integrationsSummary(await readIntegrations(home))}\n\nAsk it to work.`;
    const h = await harness([], { integrations: { home, hubRunning: async () => false }, capabilities: line, viewportRows: 30 });
    h.app.intro(await line());
    h.app.handleKey({ name: "cursor-report", at: { row: 20, col: 1 } });
    h.press("/integrations\r");
    await until(h, () => h.screen().includes("@kinoko_test_bot with Lara"));
    h.press("\r");
    await until(h, () => frame(h).join("\n").includes("The bot runs"));
    h.out.length = 0;
    h.press("\r"); // the first switch: on
    await until(h, () => h.out.join("").includes("Integrations: telegram (off)"));
    expect((await readIntegrations(home)).telegram?.on).toBe(false);
  });

  test("the menu keeps the panel's order: skills, extensions, integrations", () => {
    const names = ROOT_MENU.map((item) => item.name);
    const at = names.indexOf("skills");
    expect(names.slice(at, at + 3)).toEqual(["skills", "extensions", "integrations"]);
  });
});

/** A shell that runs until the test says how it ended. */
function lent(): { handOver: (command: string) => Promise<number>; runs: string[]; end: (code: number) => void } {
  const runs: string[] = [];
  let finish: ((code: number) => void) | undefined;
  return { runs, end: (code) => finish?.(code), handOver: (command) => (runs.push(command), new Promise((done) => (finish = done))) };
}

describe("the user's shell, lent the terminal", () => {
  test("!command: echoed, run in the shell; meanwhile kinoko neither paints nor takes keys; back after", async () => {
    const shell = lent();
    const h = await harness([], { handOver: shell.handOver, viewportRows: 30 });
    h.press("!sudo systemctl restart bluetooth\r");
    await paced();
    expect(shell.runs).toEqual(["sudo systemctl restart bluetooth"]);
    expect(h.screen()).toContain("! sudo systemctl restart bluetooth");
    h.out.length = 0;
    h.press("typed into the shell");
    h.app.render();
    expect(h.out.join("")).toBe(""); // the screen and the keyboard are the shell's
    shell.end(0);
    await paced();
    expect(h.out.join("")).toContain("\x1b[?1000h"); // clicks are kinoko's again
    expect(h.app.editorText).toBe("");
    h.press("hola");
    expect(h.app.editorText).toBe("hola");
  });

  test("/shell: an interactive one; a non-zero exit is said; refused during a run", async () => {
    const shell = lent();
    const h = await harness([], { handOver: shell.handOver });
    h.press("/shell\r");
    await paced();
    expect(shell.runs).toEqual([""]);
    expect(h.screen()).toContain("your shell: exit (or Ctrl-D) comes back to kinoko");
    shell.end(3);
    await paced();
    expect(h.app.marker).toBe("the shell exited with 3");

    const busy = await harness([[{ type: "text", delta: "slow" }, { type: "text", delta: "er" }, { type: "done", stop: "end" }]], { handOver: shell.handOver, pace: 30 });
    busy.press("go\r");
    busy.press("!ls\r");
    await new Promise((r) => setTimeout(r, 5));
    expect(busy.app.marker).toBe("a run is going: Esc it first, then the shell");
    expect(shell.runs).toEqual([""]);
    await settle(busy.agent);
  });

  test("what is printed while the shell has the terminal waits, then shows", async () => {
    const shell = lent();
    const h = await harness([], { handOver: shell.handOver });
    h.press("!make\r");
    await paced();
    await h.app.command("/model");
    expect(h.screen()).not.toContain("model: ");
    shell.end(0);
    await paced();
    expect(h.screen()).toContain("model: ");
  });
});

describe("background jobs in the TUI", () => {
  const jobsDir = `${ROOT}/jobs`;

  test("the rule shows the shells running, left of the thinking level; a click on it opens the list", async () => {
    const jobs = new Jobs({ dir: jobsDir, onEnd: () => undefined });
    const h = await harness([], { jobs, viewportRows: 30, viewportCols: 100 });
    const job = jobs.start("sleep 5", ROOT);
    await paced();
    h.app.render();
    const rule = frame(h).find((row) => row.includes("⚙ 1 shell"));
    expect(rule).toBeDefined();
    expect(rule!.indexOf("⚙ 1 shell")).toBeLessThan(rule!.indexOf("LOW · 2048"));
    // Where the terminal says the region is; then clicks down the label's column until one opens the list.
    h.app.handleKey({ name: "cursor-report", at: { row: 20, col: 1 } });
    h.app.render();
    const x = rule!.indexOf("1 shell") + 2; // 1-based, past the margin
    let opened: number | undefined;
    for (let y = 1; y <= 30 && opened === undefined; y++) {
      h.press(`\x1b[<0;${x};${y}M`);
      if (h.app.menuPage === "Background jobs") opened = y;
    }
    expect(opened).toBeDefined();
    h.press("\x1b");
    h.press(`\x1b[<0;${x};${opened! + 1}M`); // a row below: nothing
    expect(h.app.menuPage).toBeUndefined();
    jobs.kill(job.id);
    await jobs.ended(job.id);
  });

  test("/jobs: the list; Enter opens a framed window of its last lines that follows the output; Del twice stops it", async () => {
    const jobs = new Jobs({ dir: jobsDir, onEnd: () => undefined });
    const h = await harness([], { jobs, viewportRows: 40, viewportCols: 100 });
    const job = jobs.start("echo first line; sleep 0.3; echo second line; sleep 30", ROOT);
    await paced();
    h.press("/jobs\r");
    expect(h.app.menuPage).toBe("Background jobs");
    await paced();
    h.app.render();
    expect(frame(h).join("\n")).toMatch(/#1\s+● running \d+s · echo first line/);
    h.press("\r");
    expect(h.app.menuPage).toStartWith("$ echo first line");
    await paced();
    h.app.render();
    let shown = frame(h).join("\n");
    expect(shown).toMatch(/╭─ #1 · running \d+s ─+╮/);
    expect(shown).toContain("│ first line");
    await new Promise((r) => setTimeout(r, 450)); // it writes again: the window follows
    h.app.render();
    shown = frame(h).join("\n");
    expect(shown).toContain("│ second line");
    h.press("\r"); // back to the list
    expect(h.app.menuPage).toBe("Background jobs");
    h.press("\x7f");
    h.press("\x7f");
    await jobs.ended(job.id);
    expect(jobs.list()[0]?.state).toBe("killed");
    expect(h.app.marker).toBe("job #1 stopped");
    h.press("\x1b");
  });

  test("a job's end note is shown as kinoko's, not as the user's message", async () => {
    const h = await harness([[{ type: "text", delta: "on it" }, { type: "done", stop: "end" }]], { viewportRows: 30 });
    void h.agent.prompt("[kinoko] Background job #3 finished (exit 0) after 2s: `make`\nLast lines:\n```\nok\n```");
    await settle(h.agent);
    expect(h.screen()).toContain("⚙ Background job #3 finished (exit 0) after 2s: `make`");
    expect(h.screen()).not.toContain("Last lines:");
  });
});

describe("/profile", () => {
  test("lists the six with the one in use; Enter switches, the note says what changed", async () => {
    const home = `${ROOT}/profiles-home`;
    mkdirSync(`${home}/.kinoko`, { recursive: true });
    const fake = store([{ name: "web", description: "web tools", installed: true, enabled: true }]);
    const h = await harness([], { extensions: fake.store, apply: async () => "done", integrations: { home, hubRunning: async () => false }, viewportRows: 30 });
    h.press("/profile\r");
    await until(h, () => frame(h).join("\n").includes("Amanita Muscaria"));
    expect(frame(h).join("\n")).toContain("Mycena · Light and fast");
    for (let i = 0; i < 5; i++) h.press("\x1b[B"); // mycena: web goes off
    h.press("\r");
    await until(h, () => h.app.marker.startsWith("Mycena:"));
    expect(fake.toggled).toEqual(["web off"]);
    expect(h.app.marker).toContain("1 off; thinking low");
    expect(await Bun.file(`${home}/.kinoko/profile.json`).json()).toEqual({ name: "mycena" });
  });
});

/** The widths of the rows on a tool's green band, in what was written. */
const band = (chunk: string): number[] => chunk.split("\r\n").filter((row) => row.includes(STYLE.bgOk)).map((row) => visibleLength(row.replace(ANSI, "")));

describe("a resize redraws the transcript at the new width", () => {
  test("a tool's band and a reply printed wide are drawn again narrower, and wide again when it widens", async () => {
    const reply = "The tool ran fine and this sentence is long enough to wrap when the window gets narrow.";
    const turns: StreamEvent[][] = [
      [{ type: "tool_call", call: { id: "c1", name: "slow", args: {} } }, { type: "done", stop: "tool_use" }],
      [{ type: "text", delta: reply }, { type: "done", stop: "end" }],
    ];
    const h = await harness(turns, { tools: [slow], viewportRows: 30, viewportCols: 100 });
    h.press("go\r");
    await settle(h.agent);
    await new Promise((r) => setTimeout(r, 120));
    h.out.length = 0;
    h.app.resize(60, 31);
    const narrow = h.out.join("");
    expect(narrow).toContain("\x1b[2J"); // drawn again
    expect(band(narrow).length).toBeGreaterThan(0);
    expect(Math.max(...band(narrow))).toBeLessThanOrEqual(60); // no row of the band wider than the window
    expect(narrow).toContain("this sentence is long enough to wrap"); // the reply rewrapped by words
    h.out.length = 0;
    h.app.resize(100, 31);
    const wide = h.out.join("");
    expect(Math.max(...band(wide))).toBeGreaterThan(60); // the band fills the wide window again
    expect(wide).toContain(reply.slice(0, 80)); // and the reply takes the width again
  });
});

