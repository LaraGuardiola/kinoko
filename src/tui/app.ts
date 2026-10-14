// The TUI wired to the Agent. This is where interruption becomes real: the editor keeps typing
// while the model streams, Enter steers, Alt+Enter follows up, Esc cuts the run, and anything the
// user typed while it was cut comes back.
//
// Everything finished is printed above the live region, in the order it happened, so the native
// scrollback keeps the whole history and the terminal scrolls like in any other harness. The live
// region only holds the block being streamed, the running tool, the queue, the editor and the
// status line. There is ONE open block at a time: when the stream switches between thinking and
// answer (or a tool starts, or the message ends) the open block is closed and printed first.

import { KeyParser } from "./term.ts";
import type { Key } from "./term.ts";
import { Editor } from "./editor.ts";
import { Renderer } from "./render.ts";
import type { RenderState } from "./render.ts";
import { ABORTED, formatBlock, liveRegion, splitStable, statusLine, wrapTo } from "./view.ts";
import { errorBlock, pulseLevel, toolBlock, toolFailed, toolSummary } from "./tools.ts";
import { TODO_TOOL } from "./todos.ts";
import type { Todo } from "./todos.ts";
import { replayBlocks } from "./replay.ts";
import { answeredNote, approvalKey, approvalRows } from "./approval.ts";
import type { ApprovalView } from "./approval.ts";
import { MENU_ROWS, Menu, filterRoot, listRows, listWindow, pageRows } from "./menu.ts";
import type { ListPage, MenuItem } from "./menu.ts";
import { copyText } from "./clipboard.ts";
import { ROOT, THINKING, catalogPage, copyPage, helpText, profileLabel, sessionLines, thinkingPage } from "./menu-pages.ts";
import { snippets } from "./snippets.ts";
import type { ThinkingProfile } from "./menu-pages.ts";
import type { CommandHost } from "../commands.ts";
import type { Catalog, Entry, Outcome, Change } from "../catalog.ts";
import { endpointOf, endpointPage, hostOf, keyPage, labelPage, modelsPage, namePage, servedPage } from "./models-menu.ts";
import type { ModelChoice, ModelsView } from "./models-menu.ts";
import { DEFAULTS } from "../config.ts";
import type { SavedModel } from "../config.ts";
import type { Served } from "../providers/openai-compat.ts";
import type { Provider } from "../types.ts";
import { actionFor } from "./keys.ts";
import type { BlockKind, OpenBlock, QueuedView, Region, ToolLine, ToolView } from "./view.ts";
import type { Agent, RunResult } from "../loop.ts";
import type { AgentEvent } from "../loop.ts";
import type { Session } from "../session.ts";
import { sessionDir } from "../session.ts";
import { dirname } from "node:path";
import type { Image, Message } from "../types.ts";
import { modelName } from "../prompt.ts";
import { ImageRegistry, clipboardImage, imageFromFile, imagePathOf } from "./images.ts";
import { FilePicker } from "./files.ts";
import { compactingNote } from "./sprout.ts";
import { ANSI, cells, stripAnsi } from "./style.ts";
import { COPY, copyFor } from "./code.ts";
import type { CompactProgress } from "../compact.ts";
import { SidePanel } from "./side.ts";
import type { ChangesSource } from "./side.ts";
import { openIntegrations } from "./integrations-menu.ts";
import { openSessions } from "./sessions-menu.ts";
import type { SessionsHost } from "./sessions-menu.ts";
import { jobsLabel, openJobs } from "./jobs-view.ts";
import { applyProfile, currentProfile, readProfiles } from "../profiles.ts";
import type { Jobs } from "../jobs.ts";
import type { FilesState, IntegrationsHost } from "./integrations-menu.ts";
import { hubRunning, hubSocket } from "../serve/link.ts";
import { userHome } from "../home.ts";



/** What a first run without any model says. */
const NO_MODEL = [
  "No model set up yet. Open /models and pick \"+ add provider\":",
  "  a local server (llama.cpp, Ollama, LM Studio: its URL, no key), or an API (its URL and key).",
  "kinoko lists what it serves; the one you pick is kept for the next start.",
].join("\n");

export interface AppOptions {
  agent: Agent;
  /** Started with no model set up anywhere: the status says so, and a prompt leads to /models. */
  noModel?: boolean;
  /** Extensions' slash commands: in the menu, run by `/name args`. */
  extensionCommands?: { list: () => Array<{ name: string; description: string }>; get: (name: string) => ((args: string) => string | Promise<string>) | undefined };
  write: (text: string) => void;
  /** 0-based model id shown in the status line. */
  model: string;
  contextWindow: number;
  /** The thinking level shown on the rule above the editor ("LOW · 2048"). */
  thinking?: string;
  /** The thinking profile in effect at start (THINKING's name), when the config matches one. */
  thinkingProfile?: string;
  /** The engine takes a thinking token budget (Strata's reasoning_budget_tokens): profiles send it. */
  budgets?: boolean;
  /** Switching endpoints and adding models; without it the models page lists the engine's own only. */
  models?: ModelsHost;
  /** Where /extensions and /skills install from; without them their pages say so. */
  extensions?: Catalog;
  skills?: Catalog;
  /** Puts an install or a removal into effect now (loads the extension, tells the model of the
   *  skill); says how. Without it, they take effect when kinoko starts again. */
  apply?: (kind: "extensions" | "skills", name: string, change: Change) => Promise<string>;
  /** The startup panel as it is now (extensions and skills switched on or off since): its
   *  [Capabilities] lines replace the ones printed at the top. */
  capabilities?: () => Promise<string>;
  /** Background jobs (bash background: true): their label on the rule, /jobs and their windows. */
  jobs?: Jobs;
  viewportRows?: number;
  viewportCols?: number;
  /** The line under the editor (cwd and git branch). Re-read after every tool call: tools can
   *  create a repository or switch branch. */
  place?: () => Promise<string>;
  session?: Session;
  /** Called by /quit. The demo and the CLI pass the process exit. */
  onQuit?: () => void;
  /** /sessions' R: that session loaded in place of this one, and the startup panel to print again. */
  resumeSession?: (path: string) => Promise<{ session: Session; intro: string }>;
  /** /new: a new session for a new conversation, and the startup panel to print again. */
  newSession?: () => Promise<{ session: Session; intro: string }>;
  /** Rebuilds the agent after /fork moved the session head. */
  rebuild?: () => Agent;
  /** Lends the terminal to the user's shell (`command`, or an interactive one when empty) and
   *  takes it back once that ends: its exit code. */
  handOver?: (command: string) => Promise<number>;
  /** Reads the clipboard image for Ctrl+V (an Image, or why not). Tests pass a fake. */
  clipboard?: (signal: AbortSignal) => Promise<Image | string>;
  /** Where a pasted relative image path is read from, and git is asked about changes. */
  cwd?: string;
  /** The side panel's changes (git by default). Tests pass a fake. */
  changes?: ChangesSource;
  /** /integrations: where integrations.json lives, Telegram's address and whether kinoko serve
   *  runs (tests pass fakes); unset: the user's home, the real Telegram, the hub's socket. */
  integrations?: Partial<Pick<IntegrationsHost, "home" | "apiBase" | "hubRunning" | "filesExtension">>;
}

/** What the models page needs from outside the TUI: other endpoints, and somewhere to save them. */
export interface ModelsHost {
  /** The endpoint in use at start. */
  endpoint: string;
  /** Models to offer besides the engine's own: the configured one, and those added before. */
  saved: SavedModel[];
  connect: (entry: SavedModel) => Provider;
  discover: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<Served[]>;
  /** Saves one entry; answers with the list to offer from now on. */
  save: (entry: SavedModel) => Promise<SavedModel[]>;
  /** Removes one saved entry; answers with the list to offer from now on. */
  remove: (entry: SavedModel) => Promise<SavedModel[]>;
  /** Entries that cannot be removed from the TUI (the configured model, the default). */
  fixed: (entry: SavedModel) => boolean;
  /** Makes one the model new sessions start with; answers with the list to offer from now on. */
  setDefault?: (entry: SavedModel) => Promise<SavedModel[]>;
}

export class App {
  #agent: Agent;
  #renderer: Renderer;
  #parser = new KeyParser();
  #editor: Editor;
  #model: string;
  #window: number;
  #thinking: string | undefined;
  #profile: string | undefined;
  #budgets: boolean;
  #menu = new Menu();
  #host: ModelsHost | undefined;
  #catalogs: { extensions?: Catalog; skills?: Catalog };
  #apply: AppOptions["apply"];
  #capabilities: AppOptions["capabilities"];
  #jobs: Jobs | undefined;
  #extensionCommands: AppOptions["extensionCommands"];
  #noModel = false;
  /** The block with the [Capabilities] lines as printed (the startup panel, or a fresh copy). */
  #panel: { text: string; gap: boolean } | undefined;
  #panelStale = false; // changed while scrolled off screen: printed again when the menu closes
  #newSessionOf: AppOptions["newSession"];
  #resumeOf: AppOptions["resumeSession"];
  #endpoint: string;
  #saved: SavedModel[];
  #viewportRows: number | undefined;
  #viewportCols: number | undefined;
  #session: Session | undefined;
  #rebuild: (() => Agent) | undefined;
  #onQuit: (() => void) | undefined;
  #handOver: AppOptions["handOver"];
  /** The terminal is the shell's: nothing is painted, and what would be printed waits here. */
  #away: Array<() => void> | undefined;
  #placeOf: (() => Promise<string>) | undefined;
  #place = "";
  #images = new ImageRegistry();
  #clipboard: (signal: AbortSignal) => Promise<Image | string>;
  #cwd: string;
  #files: FilePicker;
  #side: SidePanel;
  #integrations: AppOptions["integrations"];

  #running = false;
  // The block being streamed (thinking or answer).
  #open: OpenBlock | undefined;
  #thinkingSeen = false; // this message already streamed its thinking
  #printedAny = false; // something is already in the scrollback: every later block gets a blank row above
  #tool: ToolView | undefined;
  // The reply's calls not started yet, in order: written so far while it streams, then all of them.
  #calls: Array<{ id?: string; index?: number; name: string; args: string }> = [];
  #written = false; // the reply is over: #calls holds all of its calls, the first one next
  #queued: QueuedView[] = [];
  #approval: ApprovalView | undefined; // a call waiting for the user's answer
  #toolBlocksFull = false; // ctrl+t
  #compacting: CompactProgress | undefined; // a summary on its way: the note animates
  #marker = ""; // one-line note above the editor ("Interrupted", "Compacted", ...)
  #retrying = false; // the marker says a retry is coming: the next reply's first token clears it
  #quiet = ""; // a marker that only informs (an extension or skill installed, a model or thinking level picked): cream, no background
  #tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
  #cost = 0;

  // The mouse is kinoko's: a click on a code block's ⧉ copies it, and while the menu is open clicks
  // pick, hovering selects and the wheel moves through it. With Shift held the terminal has it
  // (scrolling the history, selecting text). undefined: not told to the terminal yet.
  #mouse: boolean | undefined;
  #write: (text: string) => void;

  constructor(opts: AppOptions) {
    this.#agent = opts.agent;
    this.#write = opts.write;
    this.#renderer = new Renderer({
      write: opts.write,
      columns: () => this.#viewportCols ?? 80,
      rows: () => (this.#viewportRows ?? 23) + 1,
    });
    this.#editor = new Editor();
    this.#model = opts.model;
    this.#window = opts.contextWindow;
    this.#thinking = opts.thinking;
    this.#profile = opts.thinkingProfile;
    this.#budgets = opts.budgets ?? false;
    this.#host = opts.models;
    this.#catalogs = { extensions: opts.extensions, skills: opts.skills };
    // Every install, removal or switch also brings the [Capabilities] lines up to date.
    const apply = opts.apply;
    this.#apply = apply && (async (kind, name, change) => {
      const done = await apply(kind, name, change);
      await this.#refreshCapabilities();
      return done;
    });
    this.#capabilities = opts.capabilities;
    this.#jobs = opts.jobs;
    this.#extensionCommands = opts.extensionCommands;
    this.#noModel = opts.noModel === true;
    this.#jobs?.on(() => this.render()); // the label counts them
    this.#newSessionOf = opts.newSession;
    this.#resumeOf = opts.resumeSession;
    this.#endpoint = opts.models?.endpoint ?? "";
    this.#saved = opts.models?.saved ?? [];
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#session = opts.session;
    this.#rebuild = opts.rebuild;
    this.#onQuit = opts.onQuit;
    this.#handOver = opts.handOver;
    this.#placeOf = opts.place;
    this.#clipboard = opts.clipboard ?? ((signal) => clipboardImage(signal));
    this.#cwd = opts.cwd ?? process.cwd();
    this.#files = new FilePicker(this.#cwd, () => this.render());
    this.#side = new SidePanel(this.#cwd, () => this.render(), opts.changes);
    this.#integrations = opts.integrations;
    this.#agent.on((e) => this.#onAgentEvent(e));
    this.#refreshPlace();
  }

  /** Raw stdin bytes: parse then dispatch. */
  feed(chunk: string): void {
    for (const key of this.#parser.push(chunk)) this.handleKey(key);
  }

  /** A held-back lone Esc, called once per frame by the render loop. */
  pollKeys(): void {
    for (const key of this.#parser.flush()) this.handleKey(key);
  }

  /** Repaints the live region (throttled). */
  render(): void {
    if (this.#away) return;
    this.#renderer.update(this.#state());
    this.#renderer.frame();
    const menuOpen = this.#menu.page !== undefined || (this.#rootItems()?.length ?? 0) > 0;
    if (menuOpen !== this.#mouse) {
      this.#mouse = menuOpen;
      // 1003: every motion too, so hovering an item selects it; 1000: clicks only. Turning 1003 off
      // turns tracking off altogether, so 1000 comes after it.
      this.#write(menuOpen ? "\x1b[?1003h\x1b[?1006h" : "\x1b[?1003l\x1b[?1000h\x1b[?1006h");
    }
  }

  /** A resumed session: its conversation goes to the scrollback, and the context counter is back. */
  replay(messages: Message[], note: string): void {
    this.#print("system", note);
    for (const block of replayBlocks(messages, this.#printCols)) this.#print(block.kind, block.text, undefined, undefined, block.render && ((w) => block.render!(w + 2)));
    this.#images.startAfter(messages.reduce((n, m) => n + (m.images?.length ?? 0), 0));
    this.#side.history(messages);
    const usage = messages.findLast((m) => m.usage !== undefined)?.usage;
    if (usage) this.#tokens.context = usage.input + usage.output;
    // The session's totals so far: what was sent, read from the cache and generated.
    for (const m of messages) {
      this.#tokens.input += m.usage?.input ?? 0;
      this.#tokens.cacheRead += m.usage?.cacheRead ?? 0;
      this.#tokens.output += m.usage?.output ?? 0;
    }
    this.render();
  }

  /** Prints the startup panel above the region; what follows it is spaced like any other block. */
  intro(text: string, gap = false): void {
    this.#panel = { text, gap };
    this.#panelStale = false;
    this.#print("system", formatBlock("system", text, this.#width), gap, "capabilities", (w) => formatBlock("system", text, w));
  }

  /** The [Capabilities] lines as they are now: rewritten in place while on screen, else marked
   *  to be printed again once the menu closes. */
  async #refreshCapabilities(): Promise<void> {
    const panel = this.#panel;
    const fresh = await this.#capabilities?.().catch(() => undefined);
    if (panel === undefined || fresh === undefined) return;
    if (this.#away) {
      this.#away.push(() => void this.#refreshCapabilities());
      return;
    }
    const text = withCapabilities(panel.text, fresh);
    if (text === panel.text) return;
    panel.text = text;
    const printed = formatBlock("system", text, this.#width);
    const source = (w: number): string => `${panel.gap ? "\n" : ""}${formatBlock("system", text, w)}`;
    if (!this.#renderer.rewrite("capabilities", panel.gap ? `\n${printed}` : printed, source)) this.#panelStale = true;
    this.render();
  }

  /** The menu closed: capabilities that changed off screen are printed again, here. */
  #menuClosed(): void {
    if (!this.#panelStale || this.#panel === undefined) return;
    const { lines, at, end } = capabilitiesSection(this.#panel.text);
    if (at < 0) return;
    this.intro(lines.slice(at, end).join("\n"), true);
  }

  /** Updates the available terminal height after a resize. */
  resize(cols: number, rows: number): void {
    this.#viewportCols = cols;
    // The region has to stay shorter than the terminal, or its top could not be repainted.
    this.#viewportRows = Math.max(2, rows - 1);
    // Its share of the screen is news until the terminal answers the size query again.
    this.#side.resized();
    this.#renderer.update(this.#state());
    this.#renderer.flush();
  }

  // ---- what the tests and the CLI read ----
  /** The title of the menu page open on top of the root, if any. */
  get menuPage(): string | undefined {
    return this.#menu.page?.title;
  }

  get editorText(): string {
    return this.#editor.text;
  }

  /** The call waiting for the user's answer, if any. */
  get approval(): ApprovalView | undefined {
    return this.#approval;
  }

  get queued(): QueuedView[] {
    return this.#queued.map((q) => ({ ...q }));
  }

  get running(): boolean {
    return this.#running;
  }

  get marker(): string {
    return this.#marker;
  }

  /** The cwd/branch line under the editor, as it stands now (not as last painted). */
  get place(): string {
    return this.#place;
  }

  get statusLine(): string {
    return statusLine({
      running: this.#running,
      model: this.#noModel ? "no model yet" : this.#model,
      tokens: this.#tokens,
      contextWindow: this.#window,
      cost: this.#cost,
    });
  }

  // ---- input ----

  handleKey(key: Key): void {
    if (this.#away) return; // the shell has the keyboard (a stray SIGINT included)
    // The terminal answering the size query: the side panel may come or go.
    if (key.name === "size-report" || key.name === "cursor-report") {
      if (key.size) this.#side.size(key.size);
      if (key.at) this.#renderer.position(key.at.row);
      this.#renderer.update(this.#state());
      this.#renderer.flush();
      return;
    }
    if (key.name === "mouse") {
      if (this.#mouse) this.#menuMouse(key);
      else if (key.mouse?.press && key.mouse.button === 0 && key.mouse.wheel === undefined && !this.#clickJobs(key.mouse.x, key.mouse.y)) this.#clickCopy(key.mouse.x, key.mouse.y);
      return;
    }
    // An approval waiting takes its keys first (Esc denies it); ctrl-c still aborts the run.
    if (this.#approval !== undefined && key.name !== "ctrl-c") {
      const answer = approvalKey(key);
      if (answer !== undefined) this.#agent.approve(this.#approval.id, answer.allow, { by: "tui", remember: answer.remember });
      return;
    }
    // An open menu takes its keys first: arrows, Enter, Esc (which must not abort a run there).
    if (this.#menuKey(key)) return;
    if (this.#fileKey(key)) return;
    if (this.#planKey(key)) return;
    const action = actionFor(key, {
      running: this.#running || this.#agent.state === "running",
      editorEmpty: this.#editor.empty,
    });
    switch (action) {
      case "abort":
        this.#agent.abort();
        return;
      case "quit":
        this.#quit();
        return;
      case "clear-editor":
        this.#editor.clear();
        this.render();
        return;
      case "toggle-tools":
        this.#toolBlocksFull = !this.#toolBlocksFull;
        this.render();
        return;
      case "pull-queued":
        this.#pullQueued();
        return;
      case "send-now":
        // The reply being streamed is cut and the steer goes in now; nothing to cut: it waits.
        if (!this.#agent.sendNow()) this.render();
        return;
      case "cancel-queued":
        this.#takeBack(this.#agent.unqueue("all"));
        return;
      case "submit":
        void this.#submit();
        return;
      case "follow-up":
        this.#followUp();
        return;
      case "paste-image":
        void this.#pasteImage();
        return;
      case "editor": {
        if (key.name === "paste" && this.#pastedImage(key.char ?? "")) return;
        // Enter submits (as a steer or a prompt, decided in #submit); the rest edits.
        if (this.#editor.handle(key) === "submit") void this.#submit();
        this.render();
        return;
      }
      default:
        return;
    }
  }

  /** Enter: prompt when idle, steer when running. A leading slash is a command, never a prompt. */
  async #submit(): Promise<void> {
    const text = this.#editor.text.trim();
    if (text === "") return;
    if (text.startsWith("!")) {
      this.#editor.remember(text);
      this.#editor.clear();
      await this.#shell(text.slice(1).trim());
      return;
    }
    if (text.startsWith("/")) {
      this.#editor.clear();
      if (!(await this.command(text))) this.#print("system", `unknown command ${text}: try /help`);
      this.render();
      return;
    }
    // No model yet: what was typed stays, and /models opens to set one up.
    if (this.#noModel) {
      this.#openModels();
      this.render();
      return;
    }
    this.#editor.remember(text);
    this.#editor.clear();
    this.#marker = "";
    if (this.#agent.state === "running") {
      // Already running: this is a steer. It shows in the queued area until it reaches the model
      // ("delivered"), and only then joins the transcript.
      this.#agent.steer(text, this.#images.attached(text));
      this.render();
      return;
    }
    this.#running = true;
    this.#echoUser(text);
    void this.#run(text);
  }

  /** Alt+Enter: follow-up when running, plain submit when idle. */
  #followUp(): void {
    const text = this.#editor.text.trim();
    if (text === "") return;
    this.#editor.remember(text);
    this.#editor.clear();
    this.#running = true;
    this.#marker = "";
    if (this.#agent.state === "running") {
      this.#agent.followUp(text, this.#images.attached(text));
      this.render();
      return;
    }
    this.#echoUser(text);
    void this.#run(text);
  }

  async #run(text: string): Promise<void> {
    await this.#agent.prompt(text, this.#images.attached(text));
    this.#running = false;
    this.render();
  }

  /**
   * The terminal lent to the user's shell: `command` run there (`!ls`), or an interactive shell
   * until it exits (/shell). What it prints stays above; kinoko comes back below it. Not during a
   * run: its output would land in the middle of the shell's.
   */
  async #shell(command: string): Promise<void> {
    this.#closeMenu();
    if (this.#handOver === undefined) {
      this.#marker = "no terminal to lend here";
      this.render();
      return;
    }
    if (this.#running) {
      this.#marker = "a run is going: Esc it first, then the shell";
      this.render();
      return;
    }
    this.#marker = "";
    this.#print("system", command ? `${ANSI.dim}!${ANSI.reset} ${command}` : `${ANSI.dim}your shell: exit (or Ctrl-D) comes back to kinoko${ANSI.reset}`);
    this.#renderer.update(this.#state());
    this.#renderer.flush();
    this.#away = [];
    this.#renderer.suspend();
    const code = await this.#handOver(command).catch(() => -1);
    const held = this.#away;
    this.#away = undefined;
    this.#renderer.resume();
    // The shell turned the mouse off: clicks (⧉, the jobs label) are kinoko's again.
    this.#mouse = false;
    this.#write("\x1b[?1000h\x1b[?1006h");
    for (const print of held) print();
    if (code !== 0) this.#marker = `${command ? "the command" : "the shell"} exited with ${code}`;
    this.render();
  }

  #quit(): void {
    this.#renderer.release();
    this.#onQuit?.();
  }

  // ---- images ----

  /** Ctrl+V: the clipboard image goes in at the cursor as [Image #N]. */
  async #pasteImage(): Promise<void> {
    this.#addImage(await this.#clipboard(AbortSignal.timeout(5_000)));
  }

  /**
   * A paste that is one image file's path (a file dropped on the terminal) attaches the file; an
   * empty paste (the terminal found no text: the clipboard holds an image) reads the clipboard.
   * False when the paste is plain text for the editor.
   */
  #pastedImage(paste: string): boolean {
    if (paste.trim() === "") {
      void this.#pasteImage();
      return true;
    }
    const path = imagePathOf(paste);
    if (path === undefined) return false;
    void imageFromFile(path, this.#cwd).then((image) => {
      if (image === undefined) this.#editor.insert(paste); // no such file: it was text after all
      else this.#addImage(image);
      this.render();
    });
    return true;
  }

  #addImage(image: Image | string): void {
    if (typeof image === "string") this.#marker = `Image not attached: ${image}`;
    else this.#editor.insert(`${this.#images.add(image)} `);
    this.render();
  }

  /** Alt+Up: pull the newest queued message back into the editor. */
  #pullQueued(): void {
    this.#takeBack(this.#agent.unqueue("last"));
  }

  /** Queued messages taken back from the agent go into the editor, before what is typed there. */
  #takeBack(texts: string[]): void {
    if (texts.length === 0) return;
    const current = this.#editor.text.trim();
    const back = texts.join("\n");
    this.#editor.setText(current === "" ? back : `${back}\n${current}`);
    this.render();
  }

  // ---- agent events ----

  #onAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "run_start":
        // A run this terminal did not start: a prompt from the phone, through kinoko serve.
        if (!this.#running) {
          this.#running = true;
          this.#marker = "";
          this.#echoUser(e.prompt);
        }
        return;
      case "message_delta":
        this.#append("assistant", e.delta);
        return;
      case "thinking_delta":
        this.#thinkingSeen = true;
        this.#append("thinking", e.delta);
        return;
      case "request_start":
        // A request starts afresh: calls left from the last reply (an unknown tool's) are gone.
        this.#calls = [];
        this.#written = false;
        return;
      case "tool_pending": {
        // The text before the call is final; the call itself shows at once, its bullet pulsing.
        this.#closeBlock();
        // Its name first, then what it acts on as soon as that arg is complete (a write's path).
        // Each call of the reply has its own row: a new index is a new call.
        const args = e.args ? toolSummary(e.name, e.args, false) : "";
        const same = this.#calls.find((c) => c.index === e.index);
        if (same) Object.assign(same, { name: e.name }, args === "" ? {} : { args });
        else this.#calls.push({ index: e.index, name: e.name, args });
        this.render();
        return;
      }
      case "tool_start": {
        this.#closeBlock();
        const at = this.#calls.findIndex((c) => c.id === e.call.id);
        this.#calls.splice(at < 0 ? 0 : at, 1);
        this.#side.toolCall(e.call);
        this.#tool = {
          name: e.call.name,
          args: toolSummary(e.call.name, e.call.args),
          output: "",
          aborted: false,
        };
        this.render();
        return;
      }
      case "tool_output":
        if (this.#tool) {
          this.#tool.output = e.output;
          this.#tool.aborted = e.output === ABORTED;
        }
        return;
      case "tool_end":
        this.#printTool();
        // A tool may have run `git init` or switched branch: show it now, not when the run ends.
        this.#refreshPlace();
        // ...and may have changed files: the side panel's changes too, while it is on screen.
        if (this.#side.visible(this.#viewportCols)) this.#side.refresh();
        return;
      case "message_end":
        this.#finishMessage(e.message);
        return;
      case "queue_change":
        this.#syncQueued(e.steer, e.followUp);
        return;
      case "delivered":
        this.#echoUser(e.text);
        return;
      case "compacting":
        this.#compacting = { phase: e.phase, done: e.done, total: e.total ?? this.#compacting?.total };
        this.render();
        return;
      case "compacted":
        this.#compacting = undefined;
        if (e.keep >= 0) this.#marker = `compacted · ${e.keep} message${e.keep === 1 ? "" : "s"} kept as they were`;
        this.render();
        return;
      case "retry":
        // What streamed before the failure stays on screen; the model starts that reply over.
        this.#closeBlock();
        this.#calls = [];
        this.#thinkingSeen = false;
        this.#marker = `${e.error} · retry ${e.attempt}/${e.of} in ${Math.round(e.inMs / 1000)}s`;
        this.#retrying = true;
        this.render();
        return;
      case "first_token":
        if (this.#retrying) this.#marker = "";
        this.#retrying = false;
        return;
      case "approval_request":
        this.#approval = { id: e.id, call: e.call, reason: e.reason };
        this.render();
        return;
      case "approval_end": {
        if (this.#approval?.id === e.id) this.#approval = undefined;
        const note = answeredNote(e.allow, e.by);
        if (note !== "") this.#marker = this.#quiet = note;
        this.render();
        return;
      }
      case "run_end":
        this.#finishRun(e.reason, e.dropped, e.detail);
        return;
      default:
        return;
    }
  }

  /** The message is over: whatever was streaming is final, and goes to the scrollback now. */
  #finishMessage(message: Message): void {
    const usage = message.usage;
    if (usage) {
      // Every request re-sends the whole conversation, so its `input` already IS the context:
      // summing them counted the history once per tool round. The latest one is the truth.
      this.#tokens.context = (usage.input ?? 0) + (usage.output ?? 0);
      this.#tokens.input += usage.input ?? 0;
      this.#tokens.cacheRead += usage.cacheRead ?? 0;
      this.#tokens.output += usage.output ?? 0;
      this.#cost += usage.cost ?? 0;
    }
    this.#closeBlock();
    // The calls as written, each on its row until it runs; one cut off before its args were complete
    // never starts, so its pulsing line goes.
    if (message.role === "assistant") this.#written = true;
    if (message.role === "assistant") this.#calls = (message.toolCalls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: toolSummary(tc.name, tc.args) }));
    // A provider that only reports the reasoning at the end (no deltas): better late than lost.
    const thinking = message.thinking ?? "";
    if (!this.#thinkingSeen && thinking.trim() !== "") this.#print("thinking", formatBlock("thinking", thinking));
    this.#thinkingSeen = false;
    this.render();
  }

  /** One row per call: the running one first, then those waiting; while the reply streams, the newest is live,
   *  once it is over the next to run. */
  #toolLines(): ToolLine[] {
    const running = this.#tool ? [{ name: this.#tool.name, args: this.#tool.args, live: true }] : [];
    const last = this.#calls.length - 1;
    return [...running, ...this.#calls.map((c, i) => ({ name: c.name, args: c.args, live: !this.#tool && i === (this.#written ? 0 : last) }))];
  }

  #printTool(): void {
    const tool = this.#tool;
    if (!tool) return;
    this.#closeBlock();
    this.#tool = undefined;
    // With the side column on, the plan is there: its todo calls need no block in the transcript.
    if (tool.name === TODO_TOOL && !tool.aborted && !toolFailed(tool.output) && this.#sideOn) return;
    const full = this.#toolBlocksFull;
    this.#print("tool", toolBlock(tool, full, this.#printCols), undefined, undefined, (w) => toolBlock(tool, full, w + 2));
  }

  #refreshPlace(): void {
    void this.#placeOf?.()
      .then((place) => {
        this.#place = place;
        this.render();
      })
      .catch(() => undefined);
  }

  #finishRun(reason: RunResult["reason"], dropped: string[] | undefined, detail?: string): void {
    this.#refreshPlace();
    if (this.#side.visible(this.#viewportCols)) this.#side.refresh();
    this.#running = false;
    this.#calls = [];
    this.#queued = [];
    this.#closeBlock();
    this.#thinkingSeen = false;
    if (dropped !== undefined && dropped.length > 0) {
      // Nothing the user typed is ever lost: it goes back into the editor.
      const back = dropped.join("\n");
      const current = this.#editor.text.trim();
      this.#editor.setText(current === "" ? back : `${back}\n${current}`);
      this.#marker = "Interrupted — your queued messages are back in the editor";
    } else if (reason === "aborted") {
      this.#marker = "Interrupted";
    } else if (reason === "error") {
      // A failed run says why where it happened, on a band like a failed tool's; the marker points at it.
      const why = detail ?? "unknown error";
      this.#print("tool", errorBlock(why, this.#width), undefined, undefined, (w) => errorBlock(why, w));
      this.#marker = "Stopped — error";
    } else if (reason === "limit") {
      // A run that stops on its own must say why, or it looks like the model gave up.
      this.#marker = `Stopped — ${detail ?? reason}`;
    }
    this.render();
  }

  // ---- ordered blocks ----

  /** Adds streamed text to the open block; a different kind of text closes it first. */
  #append(kind: "thinking" | "assistant", delta: string): void {
    if (this.#open !== undefined && this.#open.kind !== kind) this.#closeBlock();
    // Whitespace between two blocks must not open a block of its own.
    if (this.#open === undefined && delta.trim() === "") return;
    const open = (this.#open ??= { kind: kind, text: "", gap: this.#printedAny });
    open.text += delta;
    this.#spill();
  }

  /** Streaming text taller than the region: the stable head moves to the scrollback, in order. */
  #spill(): void {
    const open = this.#open;
    if (open === undefined) return;
    const split = splitStable(open.text, this.#printCols);
    if (split === undefined) return;
    const chunk = formatBlock(open.kind, split.commit, this.#width);
    const gap = open.gap;
    this.#open = { kind: open.kind, text: split.rest, gap: split.gap };
    if (chunk !== "") this.#print(open.kind, chunk, gap, undefined, (w) => formatBlock(open.kind, split.commit, w));
  }

  /** Prints what is left of the open block and forgets it. */
  #closeBlock(): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const text = formatBlock(open.kind, open.text, this.#width);
    if (text !== "") this.#print(open.kind, text, open.gap, undefined, (w) => formatBlock(open.kind, open.text, w));
  }

  /** Sends one finished piece to the scrollback. `gap` defaults to the usual blank row between blocks. */
  #print(kind: BlockKind, text: string, gap = this.#printedAny, key?: string, render?: (width: number) => string): void {
    if (text === "") return;
    if (this.#away) {
      this.#away.push(() => this.#print(kind, text, gap, key, render));
      return;
    }
    // The renderer repaints the region right after the text: it has to know the current state.
    this.#renderer.update(this.#state());
    // `render` draws it again at another text width (a resize): a reply rewraps, a band refills.
    const source = render && ((w: number): string => (gap ? `\n${render(w)}` : render(w)));
    this.#renderer.printAbove(gap ? `\n${text}` : text, key, source);
    this.#printedAny = true;
  }

  #syncQueued(steer: string[], followUp: string[]): void {
    this.#queued = [
      ...steer.map((text) => ({ kind: "steer" as const, text: text })),
      ...followUp.map((text) => ({ kind: "followUp" as const, text: text })),
    ];
    this.render();
  }

  #echoUser(text: string): void {
    // Closing first keeps the order true: what was already streamed stays above the message.
    this.#closeBlock();
    // kinoko's own words to the model (a background job ended) are not the user's.
    const note = `⚙ ${text.slice(9).split("\n")[0]}`;
    if (text.startsWith("[kinoko] ")) this.#print("system", formatBlock("system", note, this.#width), undefined, undefined, (w) => formatBlock("system", note, w));
    else this.#print("user", formatBlock("user", text));
    this.render();
  }

  // ---- the live region ----

  /** Columns a printed row may take: the renderer keeps a margin on each side. */
  get #width(): number {
    return (this.#printCols ?? 80) - 2;
  }

  /** The transcript's columns: the window's, less the side column's when it is on. */
  get #printCols(): number | undefined {
    const column = this.#side.column(this.#viewportCols);
    return column === undefined ? this.#viewportCols : (this.#viewportCols ?? 80) - column.width - 2;
  }

  get #sideOn(): boolean {
    return this.#side.column(this.#viewportCols) !== undefined;
  }

  /** Asks the terminal where the region is: the side column is drawn from the screen's top row. */
  locate(): void {
    this.#renderer.requestPosition();
  }

  #state(): RenderState {
    const cols = this.#viewportCols;
    const column = this.#side.column(cols);
    const region = this.#region(cols, column === undefined ? undefined : (cols ?? 80) - column.width - 2);
    if (column === undefined || cols === undefined) return region;
    // The column runs from the screen's top row down to the input's rule, on the right.
    const side = { col: cols - column.width, upper: region.upper, rows: column.rows, key: column.key, text: (this.#printCols ?? 80) - 2 };
    return { ...region, side };
  }

  #region(cols: number | undefined, tailCols: number | undefined): Region {
    // The block cursor may sit one column past the text, plus the renderer's margins.
    const editorWidth = Math.max(1, (cols ?? 80) - 3);
    const view = this.#editor.view(wrapTo(editorWidth));
    return liveRegion({
      open: this.#open,
      tools: this.#toolLines(),
      // Until the result is in, the bullet fades in and out (the render timer repaints each step).
      pulse: this.#tool || this.#calls.length > 0 ? pulseLevel(Date.now()) : undefined,
      toolGap: this.#printedAny,
      // While compacting: mushrooms and how far it is (the clock moves them on each frame).
      marker: this.#compacting ? compactingNote(this.#compacting, Date.now()) : this.#marker,
      markerAlert: !this.#compacting && this.#marker.startsWith("Interrupted"),
      markerCream: this.#compacting !== undefined || this.#marker.startsWith("compacted") || (this.#quiet !== "" && this.#marker === this.#quiet),
      queued: this.#queued,
      approval: this.#approval === undefined ? undefined : approvalRows(this.#approval),
      editorLines: view.lines,
      editorRow: view.row,
      editorCol: view.col,
      status: this.statusLine,
      place: this.#place,
      thinking: this.#thinking,
      jobs: jobsLabel(this.#jobs?.running ?? 0),
      menu: this.#menuRows(),
      tailCols,
      viewportRows: this.#viewportRows,
      viewportCols: cols,
    });
  }

  // ---- slash commands ----

  /** Runs a slash command. Returns false when the name is unknown. */
  async command(input: string): Promise<boolean> {
    const [name = ""] = input.replace(/^\//, "").split(" ");
    switch (name) {
      case "help":
        this.#print("system", helpText(this.#width), undefined, undefined, (w) => helpText(w));
        this.render();
        return true;
      case "model":
        this.#print("system", `model: ${modelName(this.#model)}  context: ${this.#window} tokens`);
        this.render();
        return true;
      case "compact": {
        const done = await this.#agent.compactNow();
        if (!done) this.#marker = "nothing to compact yet";
        this.render();
        return true;
      }
      case "fork": {
        const moved = await this.#forkHead();
        this.#print("system", moved);
        this.render();
        return true;
      }
      case "clear":
        this.#clearScreen();
        this.render();
        return true;
      case "new":
        await this.#newSession();
        this.render();
        return true;
      case "quit":
        this.#quit();
        return true;
      case "shell":
        await this.#shell(input.replace(/^\/?shell\s*/, ""));
        return true;
      default:
        return this.#extensionCommand(name, input.replace(/^\/?\S+\s*/, ""));
    }
  }

  /** Started with no model: the panel is followed by how to set one up. */
  noModelHint(): void {
    if (this.#noModel) this.#print("system", NO_MODEL);
    this.render();
  }

  /** An extension's command: what it answers, printed here; one that throws says so. */
  async #extensionCommand(name: string, args: string): Promise<boolean> {
    const run = this.#extensionCommands?.get(name);
    if (run === undefined) return false;
    this.#print("system", `${ANSI.dim}/${name}${args ? ` ${args}` : ""}…${ANSI.reset}`);
    this.render();
    const answer = await Promise.resolve()
      .then(() => run(args))
      .catch((e: unknown) => `/${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    this.#print("system", answer);
    this.render();
    return true;
  }

  // ---- the slash menu ----

  /** The root is open while the editor holds only a slash command being typed. */
  #rootItems(): MenuItem[] | undefined {
    if (this.#menu.page !== undefined || !/^\/\S*$/.test(this.#editor.text)) return undefined;
    // The built-in ones, then what extensions add (a built-in name keeps its own).
    const added = (this.#extensionCommands?.list() ?? []).filter((c) => !ROOT.some((r) => r.name === c.name));
    return filterRoot([...ROOT, ...added], this.#editor.text);
  }

  #menuRows(): string[] {
    const page = this.#menu.page;
    if (page) return pageRows(page, this.#menu.index, this.#menu.text, this.#menu.armed);
    const items = this.#rootItems() ?? [];
    this.#menu.clamp(items.length);
    if (items.length > 0) return listRows(items, this.#menu.index);
    this.#files.sync(this.#editor.text, this.#editor.cursor);
    if (!this.#files.open) return [];
    const empty = this.#files.entries === undefined ? "reading…" : "no matches";
    return listRows(this.#files.items(), this.#files.index, `Files · ${this.#files.where}`, empty, undefined, "Tab or Enter to complete · Esc to close");
  }

  /**
   * Ctrl+O unfolds the plan over the side column (or prints it, when the window is too narrow for
   * the column); unfolded, the arrows, PgUp/PgDn and Home/End scroll it by tasks and Esc folds it.
   */
  #planKey(key: Key): boolean {
    const column = this.#side.column(this.#viewportCols);
    if (key.name === "ctrl-o") {
      if (column !== undefined) this.#side.toggle();
      else if (this.#side.todos.length === 0) this.#marker = "no plan yet";
      else this.#print("system", planLines(this.#side.todos));
      this.render();
      return true;
    }
    if (column === undefined || !this.#side.expanded || key.alt) return false;
    const by =
      key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -5 : key.name === "pagedown" ? 5 : key.name === "home" ? "start" : key.name === "end" ? "end" : undefined;
    if (by !== undefined) this.#side.scroll(by, column.width);
    else if (key.name === "escape") this.#side.fold();
    else return false;
    this.render();
    return true;
  }

  /** The keys the "@" file picker takes while it is open: arrows, Tab/Enter to complete, Esc. */
  #fileKey(key: Key): boolean {
    this.#files.sync(this.#editor.text, this.#editor.cursor);
    if (!this.#files.open || key.alt) return false;
    if (key.name === "up" || key.name === "down") {
      this.#files.move(key.name === "up" ? -1 : 1);
    } else if (key.name === "tab" || key.name === "enter") {
      const edit = this.#files.accept();
      if (edit === undefined) return key.name === "tab"; // nothing to complete: Enter sends as usual
      const text = this.#editor.text;
      this.#editor.setText(text.slice(0, edit.start) + edit.text + text.slice(edit.end), edit.start + edit.text.length);
    } else if (key.name === "escape") {
      this.#files.dismiss();
    } else {
      return false;
    }
    this.render();
    return true;
  }

  /** The keys an open menu takes; false hands the key to the rest of the app. */
  #menuKey(key: Key): boolean {
    const page = this.#menu.page;
    const items = page ? [] : (this.#rootItems() ?? []);
    if (!page && items.length === 0) return false;
    const count = page?.kind === "list" ? page.items.length : items.length;
    if (page?.kind === "input" && key.name !== "escape") {
      // An input page takes the typing; Enter hands the text over (it may open the next step).
      if (key.name === "char" || key.name === "paste") this.#menu.type(key.char ?? "");
      else if (key.name === "backspace") this.#menu.erase();
      else if (key.name === "enter") page.submit(this.#menu.text);
      else if (key.name === "ctrl-c") this.#closeMenu();
    } else if (page?.kind === "list" && page.remove && (key.name === "delete" || key.name === "backspace")) {
      // Del twice on a removable item: the first arms it, the second removes it.
      const item = page.items[this.#menu.index];
      if (item?.removable && item.key !== undefined) {
        if (this.#menu.armed === item.key) page.remove(item);
        else this.#menu.arm(item.key);
      }
    } else if (page?.kind === "info" && key.name === "char" && page.keys?.[key.char?.toLowerCase() ?? ""]) {
      page.keys[key.char?.toLowerCase() ?? ""]?.();
    } else if (page?.kind === "list" && key.name === "char" && page.keys?.[key.char?.toLowerCase() ?? ""]) {
      const item = page.items[this.#menu.index];
      if (item !== undefined && !item.header) page.keys[key.char?.toLowerCase() ?? ""]?.(item);
    } else if (page?.kind === "list" && page.update && key.name === "char" && key.char?.toLowerCase() === "u") {
      const item = page.items[this.#menu.index];
      if (item !== undefined && !item.header) page.update(item);
    } else if ((key.name === "up" || key.name === "down") && !key.alt) {
      this.#menu.arm(undefined); // moving away cancels a pending removal
      this.#menu.move(key.name === "up" ? -1 : 1, count, (i) => page?.kind === "list" && page.items[i]?.header === true);
    } else if (key.name === "escape") {
      // A page goes back to the root; the root closes, back to an empty input.
      if (!this.#menu.back()) {
        this.#editor.clear();
        this.#menuClosed();
      }
    } else if (key.name === "enter" && !key.alt) {
      if (page?.kind === "list") {
        const item = page.items[this.#menu.index];
        if (item === undefined || item.header) return true;
        page.pick(item);
        // A pick that opened another page (add model) keeps the menu, as does a page that stays
        // (switching things on and off); any other pick is done.
        if (this.#menu.page === page && !page.stay) this.#closeMenu();
      } else if (page?.kind === "info" && page.next) {
        page.next();
      } else if (page) {
        this.#menu.back();
      } else {
        this.#openRoot(items[this.#menu.index]!);
      }
    } else if (page === undefined) {
      this.#menu.close(); // typing narrows the root: start again from its first item
      return false;
    } else if (key.name === "ctrl-c") {
      this.#closeMenu();
    } // a page takes no typing
    this.render();
    return true;
  }

  /** The wheel moves through the open menu; a click on an item picks it, as Enter would. */
  #menuMouse(key: Key): void {
    const m = key.mouse;
    if (m === undefined) return;
    if (m.wheel !== undefined) {
      this.#menuKey({ name: m.wheel === "up" ? "up" : "down" });
      return;
    }
    const index = this.#menuItemAt(m.y);
    if (index === undefined) return;
    // Hovering an item selects it (bold, its arrow); a click picks it, as Enter would.
    if (m.move) {
      if (index !== this.#menu.index) {
        this.#menu.select(index);
        this.render();
      }
      return;
    }
    if (!m.press || m.button !== 0) return;
    this.#menu.select(index);
    this.#menuKey({ name: "enter" });
  }

  /** The menu item on screen row `y`, if there is one. */
  #menuItemAt(y: number): number | undefined {
    const top = this.#renderer.top;
    const page = this.#menu.page;
    const items = page?.kind === "list" ? page.items : page === undefined ? (this.#rootItems() ?? []) : undefined;
    if (top === undefined || items === undefined) return undefined;
    // The menu sits at the region's foot: its rows, then the place line (if any), then the status.
    const rows = this.#state().lines.length;
    const menu = this.#menuRows().length;
    const end = top + rows - 1 - 1 - (this.#place ? 1 : 0);
    const row = y - (end - menu + 1) - (page === undefined ? 0 : 1); // a page's first row is its title
    const index = listWindow(items.length, this.#menu.index) + row;
    if (row < 0 || row >= Math.min(items.length, MENU_ROWS) || items[index] === undefined || items[index]?.header) return undefined;
    return index;
  }

  #closeMenu(): void {
    this.#menu.close();
    this.#editor.clear();
    this.#menuClosed();
  }

  /** The profiles, the one in use marked; Enter switches to one (installs, switches, thinking, asks). */
  #openProfiles(): void {
    const home = this.#integrations?.home ?? userHome();
    const loading: ListPage = { kind: "list", title: "Profiles", items: [], empty: "reading…", pick: () => undefined, stay: true };
    this.#menu.open(loading);
    void Promise.all([readProfiles(home), currentProfile(home)]).then(([all, current]) => {
      this.#menu.refresh(loading, {
        kind: "list",
        title: "Profiles",
        items: all.map((p) => ({ name: p.name, description: `${p.title} · ${p.description}`, current: p.name === current })),
        empty: "",
        hint: "Enter switches to it: what is on, how much it thinks, what it asks",
        pick: (item) => {
          const profile = all.find((p) => p.name === item.name);
          if (profile === undefined) return;
          this.#marker = this.#quiet = `switching to ${profile.title}…`;
          void applyProfile(this.commandHost(), home, profile, AbortSignal.timeout(300_000))
            .catch((e: unknown) => `${profile.title}: ${errorText(e)}`)
            .then(async (note) => {
              await this.#refreshCapabilities();
              this.#marker = this.#quiet = note;
              this.render();
            });
        },
      });
      this.render();
    });
  }

  #openJobs(): void {
    const jobs = this.#jobs;
    if (jobs === undefined) {
      this.#menu.open({ kind: "info", title: "Background jobs", lines: ["  not available in this mode"] });
      return;
    }
    openJobs({
      jobs,
      open: (page) => {
        this.#menu.open(page);
        this.render();
      },
      swap: (from, to) => {
        this.#menu.swap(from, to);
        this.render();
      },
      note: (text) => {
        this.#marker = this.#quiet = text;
        this.render();
      },
      // The window fills what the menu may take: the screen less the input and its rules.
      size: () => ({ cols: (this.#printCols ?? 80) - 2, rows: Math.min(18, Math.max(3, (this.#viewportRows ?? 24) - 12)) }),
    });
  }

  /** A click on the rule's jobs label opens their list. */
  #clickJobs(x: number, y: number): boolean {
    const label = jobsLabel(this.#jobs?.running ?? 0);
    const row = this.#renderer.rowAt(y);
    if (label === undefined || row === undefined) return false;
    const plain = [...cells(stripAnsi(row))].flatMap((c) => Array.from({ length: Math.max(1, c.width) }, () => c.text)).join("");
    const at = plain.indexOf(label.slice(2)); // past the gear, whose width terminals disagree on
    if (at < 0 || x < at - 1 || x > at + label.length + 1) return false;
    this.#editor.clear();
    this.#openJobs();
    return true;
  }

  #integrationsHost(): IntegrationsHost {
    const home = this.#integrations?.home ?? userHome();
    return {
      home,
      apiBase: this.#integrations?.apiBase,
      open: (page) => {
        this.#menu.open(page);
        this.render();
      },
      swap: (from, to) => {
        this.#menu.swap(from, to);
        this.render();
      },
      note: (text) => {
        this.#marker = this.#quiet = text;
        this.render();
      },
      changed: () => void this.#refreshCapabilities(),
      hubRunning: this.#integrations?.hubRunning ?? (() => hubRunning(hubSocket(home))),
      filesExtension: this.#integrations?.filesExtension ?? this.#telegramExtension(),
    };
  }

  /** The telegram extension through the extensions catalog, as /extensions installs it. */
  #telegramExtension(): IntegrationsHost["filesExtension"] {
    const store = this.#catalogs.extensions;
    if (store === undefined) return undefined;
    const NAME = "telegram";
    const state = async (): Promise<FilesState> => {
      const entry = (await store.local()).find((e) => e.name === NAME);
      return !entry?.installed ? "missing" : entry.enabled === false ? "off" : "on";
    };
    const apply = async (change: Change, done: Outcome): Promise<string> =>
      done.ok && this.#apply ? `${done.note}: ${await this.#apply("extensions", NAME, change).catch((e: unknown) => `not applied: ${errorText(e)}`)}` : done.note;
    return {
      state,
      turnOn: async () => {
        const signal = AbortSignal.timeout(300_000);
        if ((await state()) === "off") return apply("enable", await store.enable(NAME, true));
        await store.list(signal); // the newest catalog: an old copy may not have it yet
        return apply("install", await store.install(NAME, signal));
      },
    };
  }

  #openRoot(item: MenuItem): void {
    if (item.name === "thinking") this.#menu.open(this.#thinkingPage());
    else if (item.name === "models") this.#openModels();
    else if (item.name === "extensions" || item.name === "skills") this.#openCatalog(item.name);
    else if (item.name === "sessions") openSessions(this.#sessionsHost());
    else if (item.name === "jobs") this.#openJobs();
    else if (item.name === "integrations") openIntegrations(this.#integrationsHost());
    else if (item.name === "profile") this.#openProfiles();
    else if (item.name === "copy") this.#menu.open(copyPage(snippets(this.#agent.messages), (s) => this.#copy(s.code)));
    else {
      this.#closeMenu();
      void this.command(`/${item.name}`).then(() => this.render());
    }
  }

  /** A click on a code block's ⧉ (or the cell either side of it) copies the block. */
  #clickCopy(x: number, y: number): void {
    const row = this.#renderer.rowAt(y);
    if (row === undefined) return;
    const chars: string[] = [];
    for (const cell of cells(stripAnsi(row))) for (let i = 0; i < Math.max(1, cell.width); i++) chars.push(cell.text);
    if (![x - 2, x - 1, x].some((i) => chars[i] === COPY)) return;
    const below: string[] = [];
    for (let next = this.#renderer.rowAt(y + 1), i = 2; next !== undefined && below.length < 8; next = this.#renderer.rowAt(y + i++)) below.push(next);
    const code = copyFor(below);
    if (code === undefined) return;
    this.#copy(code);
    this.render();
  }

  #copy(text: string): void {
    const lines = text.split("\n").length;
    this.#marker = this.#quiet = `copied: ${lines} line${lines === 1 ? "" : "s"}`;
    void copyText(text, (data) => this.#write(data), AbortSignal.timeout(5000));
  }

  #thinkingPage(): ListPage {
    return thinkingPage(this.#profile, (profile) => this.#chooseThinking(profile));
  }

  #chooseThinking(profile: ThinkingProfile): string {
    // Only an engine that takes a budget gets one; elsewhere the effort alone is the level.
    this.#agent.setThinking(profile.effort, this.#budgets ? profile.budget : undefined);
    this.#profile = profile.name;
    this.#thinking = profileLabel(profile, this.#budgets);
    this.#marker = this.#quiet = `thinking: ${this.#thinking} from the next request`;
    return this.#marker;
  }

  /** What the phone's slash commands act on (through kinoko serve): this TUI, so its screen follows. */
  commandHost(): CommandHost {
    return {
      agent: this.#agent,
      ...(this.#jobs ? { jobs: this.#jobs } : {}),
      catalogs: this.#catalogs,
      apply: this.#apply,
      newSession: async () => {
        await this.#newSession();
        this.render();
      },
      thinking: {
        current: () => this.#profile,
        set: (name) => {
          const profile = THINKING.find((p) => p.name === name);
          if (profile === undefined) return `no thinking profile ${name}`;
          const note = this.#chooseThinking(profile);
          this.render();
          return note;
        },
      },
      models: {
        // The saved models (any endpoint) and what the engine in use serves, once each.
        list: async (signal) => {
          const items = new Map(this.#saved.map((e) => [e.model, { name: e.model, description: e.label ?? hostOf(e.baseUrl) }]));
          for (const m of await this.#agent.models(signal).catch(() => [] as string[])) if (!items.has(m)) items.set(m, { name: m, description: `served by ${hostOf(this.#endpoint)}` });
          return [...items.values()];
        },
        set: (name) => {
          const current = this.#saved.find((e) => e.baseUrl === this.#endpoint);
          this.#useModel(this.#saved.find((e) => e.model === name) ?? { model: name, baseUrl: this.#endpoint, apiKey: current?.apiKey ?? "" });
          this.render();
          return this.#marker;
        },
      },
      clear: () => {
        this.#clearScreen();
        this.render();
      },
      fork: async () => {
        const moved = await this.#forkHead();
        this.#print("system", moved);
        this.render();
        return moved;
      },
      session: () => {
        const s = this.#session;
        if (s === undefined) return "no session";
        const facts = { path: s.path, id: s.meta.id, created: s.meta.created, messages: this.#agent.messages, context: this.#tokens.context, window: this.#window };
        return stripAnsi(sessionLines(facts, 60).join("\n"));
      },
      told: (note) => {
        this.#marker = this.#quiet = note;
        void this.#refreshCapabilities(); // a profile switched from the phone: the panel says which
        this.render();
      },
    };
  }

  #openModels(): void {
    // Every provider is asked what it serves (the one in use through the agent), in parallel; the
    // page fills in as they answer.
    const served = new Map<string, Served[]>();
    const others = [...new Map(this.#saved.filter((m) => m.baseUrl !== this.#endpoint).map((m) => [m.baseUrl, m])).values()];
    let pending = 1 + (this.#host ? others.length : 0);
    const view = (): ModelsView => ({
      model: this.#model,
      endpoint: this.#endpoint,
      served,
      loading: pending > 0,
      saved: this.#saved,
      canAdd: this.#host !== undefined,
      fixed: this.#host?.fixed,
      canDefault: this.#host?.setDefault !== undefined,
    });
    const choose = (choice: ModelChoice): void => {
      if (choice.kind === "add") this.#addProvider();
      // The redrawn page becomes the one later answers refresh.
      else if (choice.kind === "remove") this.#removeModel(choice.entry, () => (page = modelsPage(view(), choose)));
      else if (choice.kind === "default") this.#defaultModel(choice.entry, () => (page = modelsPage(view(), choose)));
      else this.#useModel(choice.entry);
    };
    let page = modelsPage(view(), choose);
    this.#menu.open(page);
    const answered = (baseUrl: string, list: Served[]): void => {
      pending--;
      if (list.length > 0) served.set(baseUrl, list);
      const next = modelsPage(view(), choose);
      this.#menu.refresh(page, next);
      page = next;
      this.render();
    };
    void this.#agent
      .models(AbortSignal.timeout(10_000))
      .catch(() => [])
      .then((names) => answered(this.#endpoint, names.map((id) => ({ id }))));
    for (const entry of this.#host ? others : []) {
      void this.#host
        ?.discover(entry.baseUrl, entry.apiKey, AbortSignal.timeout(10_000))
        .catch(() => [])
        .then((list) => answered(entry.baseUrl, list));
    }
  }

  /** A catalog's page: what is on disk at once, the repository's news after; install and remove. */
  #openCatalog(which: "extensions" | "skills"): void {
    const store = this.#catalogs[which];
    const title = which === "skills" ? "Skills" : "Extensions";
    if (store === undefined) {
      this.#menu.open({ kind: "info", title, lines: ["  not available in this mode"] });
      return;
    }
    const state: { repo: string; entries?: Entry[]; error?: string } = { repo: store.repo };
    // On disk first, then into effect: loaded now, or (without `apply`) at the next start.
    const settle = async (name: string, change: Change, done: Outcome): Promise<Outcome> => {
      if (!done.ok) return done;
      const how = this.#apply ? await this.#apply(which, name, change).catch((e: unknown) => `not applied: ${errorText(e)}`) : "restart kinoko to apply it";
      return { ok: true, note: `${done.note}: ${how}` };
    };
    const install = (name: string): void => {
      this.#marker = this.#quiet = `${state.entries?.find((e) => e.name === name)?.installed ? "updating" : "installing"} ${name}…`;
      void store
        .install(name, AbortSignal.timeout(300_000))
        .then((done) => settle(name, "install", done))
        .catch((e: unknown) => ({ ok: false, note: `${name} did not install: ${errorText(e)}` }))
        .then(({ ok, note }) => {
          this.#marker = this.#quiet = note;
          const entry = state.entries?.find((e) => e.name === name);
          if (entry && ok) {
            entry.installed = true;
            entry.enabled = true;
          }
          redraw();
        });
    };
    // On or off, at once: loaded or taken back (a skill: told to the model), still installed.
    const toggle = (name: string, on: boolean): void => {
      void store
        .enable(name, on)
        .then((done) => settle(name, on ? "enable" : "disable", done))
        .then(({ ok, note }) => {
          this.#marker = this.#quiet = note;
          const entry = state.entries?.find((e) => e.name === name);
          if (entry && ok) entry.enabled = on;
          redraw();
        });
    };
    const remove = (name: string): void => {
      void store
        .remove(name)
        .then((done) => settle(name, "remove", done))
        .then(({ ok, note }) => {
          this.#marker = this.#quiet = note;
          const entry = state.entries?.find((e) => e.name === name);
          if (entry && ok) entry.installed = false;
          redraw();
        });
    };
    const actions = { install, toggle, update: install, remove };
    let page = catalogPage(title, state, actions);
    const redraw = (): void => {
      const next = catalogPage(title, state, actions);
      this.#menu.swap(page, next); // the selection stays on the entry just acted on
      page = next;
      this.render();
    };
    this.#menu.open(page);
    // What is on disk first (instant, and all there is offline), then the repository's news.
    void store
      .local()
      .then((entries) => {
        state.entries ??= entries;
        redraw();
        return store.list(AbortSignal.timeout(60_000));
      })
      .then((entries) => (state.entries = entries))
      .catch((e: unknown) => (state.error = errorText(e)))
      .then(redraw);
  }

  /** Forgets a saved model; the models page stays open, redrawn without it. */
  #removeModel(entry: SavedModel, redraw: () => ListPage): void {
    const page = this.#menu.page;
    void this.#host
      ?.remove(entry)
      .then((saved) => {
        this.#saved = saved;
        if (page) this.#menu.refresh(page, redraw());
        this.#marker = this.#quiet = `removed ${modelName(entry.model)} at ${hostOf(entry.baseUrl)}`;
      })
      .catch(() => (this.#marker = `could not remove ${modelName(entry.model)}`))
      .finally(() => this.render());
  }

  /** Makes a model the default for new sessions (config.json); the models page stays open, redrawn. */
  #defaultModel(entry: SavedModel, redraw: () => ListPage): void {
    const page = this.#menu.page;
    void this.#host
      ?.setDefault?.(entry)
      .then((saved) => {
        this.#saved = saved;
        if (page) this.#menu.swap(page, redraw()); // the same model stays selected
        this.#marker = this.#quiet = `default: ${modelName(entry.model)} at ${hostOf(entry.baseUrl)}, for new sessions`;
      })
      .catch(() => (this.#marker = `could not make ${modelName(entry.model)} the default`))
      .finally(() => this.render());
  }

  /** Its name, endpoint, API key, then one of the models it serves (or its id typed by hand). */
  #addProvider(): void {
    this.#menu.open(
      labelPage((typedLabel) => {
        const label = typedLabel.trim();
        if (label === "") return; // nothing typed: stay on this step
        this.#menu.open(
          endpointPage((typed) => {
            const baseUrl = endpointOf(typed);
            if (baseUrl === undefined) return;
            this.#menu.open(keyPage((apiKey) => this.#discover(label, baseUrl, apiKey.trim())));
          }),
        );
      }),
    );
  }

  #discover(label: string, baseUrl: string, apiKey: string): void {
    const host = hostOf(baseUrl);
    const keep = (served: Served): void => {
      const entry: SavedModel = { model: served.id, baseUrl, apiKey, contextWindow: served.contextWindow, label };
      this.#closeMenu();
      this.#useModel(entry);
      void this.#host
        ?.save(entry)
        .then((saved) => {
          this.#saved = saved;
          this.#marker = this.#quiet = `model: ${modelName(entry.model)} at ${host}, saved`;
        })
        .catch(() => (this.#marker = `model: ${modelName(entry.model)} at ${host} (could not save it)`))
        .finally(() => this.render());
    };
    const asking = servedPage(host, undefined, keep);
    this.#menu.open(asking);
    // An endpoint that answers but lists nothing, and one that does not answer at all, both lead
    // to typing the id; only the second is probably a mistake (a wrong port, a server not started).
    const byHand = (reachable: boolean): void => {
      this.#menu.refresh(asking, namePage(host, reachable, (id) => id.trim() && keep({ id: id.trim() })));
    };
    void this.#host
      ?.discover(baseUrl, apiKey, AbortSignal.timeout(10_000))
      .then((served) => (served.length > 0 ? this.#menu.refresh(asking, servedPage(host, served, keep)) : byHand(true)))
      .catch(() => byHand(false))
      .finally(() => this.render());
  }

  /** Switches to a model, and to its endpoint when it is served elsewhere; then its window. */
  #useModel(entry: SavedModel): void {
    this.#noModel = false;
    if (entry.baseUrl !== this.#endpoint && this.#host) {
      this.#agent.setProvider(this.#host.connect(entry));
      this.#endpoint = entry.baseUrl;
    }
    this.#agent.setModel(entry.model);
    this.#model = entry.model;
    this.#marker = this.#quiet = `model: ${modelName(entry.model)}${entry.baseUrl === "" ? "" : ` at ${hostOf(entry.baseUrl)}`} from the next request`;
    if (entry.contextWindow) this.#useWindow(entry.contextWindow);
    else this.#learnWindow(entry);
    this.#recordModel(entry, entry.contextWindow);
  }

  /** The session remembers the switch (and the window, once known), so a resume starts with it. */
  #recordModel(entry: SavedModel, contextWindow: number | undefined): void {
    const record = { model: entry.model, baseUrl: entry.baseUrl, ...(contextWindow ? { contextWindow } : {}) };
    void this.#session?.setModel(record).catch(() => undefined);
  }

  #useWindow(window: number): void {
    this.#agent.setContextWindow(window);
    this.#window = window;
  }

  /**
   * A model picked without a known window (typed by hand, or served by the engine in use): ask its
   * endpoint, use what it says, and keep it on a saved entry so the next pick knows it at once.
   * Until then the previous window stands; if it never says (or does not answer), the default one,
   * as a fresh start has, and the marker says so.
   */
  #learnWindow(entry: SavedModel): void {
    const host = this.#host;
    if (!host || entry.baseUrl === "") return;
    void host
      .discover(entry.baseUrl, entry.apiKey, AbortSignal.timeout(10_000))
      .catch(() => [] as Served[])
      .then(async (served) => {
        const window = served.find((s) => s.id === entry.model)?.contextWindow;
        if (this.#model !== entry.model) return; // another pick came first
        if (!window) {
          // The last model's window says nothing about this one: the default, as a fresh start has.
          this.#useWindow(DEFAULTS.contextWindow);
          this.#marker = this.#quiet = `model: ${modelName(entry.model)} (its context window is unknown: ${DEFAULTS.contextWindow.toLocaleString("en-US")}, the default)`;
          return;
        }
        this.#useWindow(window);
        this.#recordModel(entry, window);
        const saved = this.#saved.some((m) => m.baseUrl === entry.baseUrl && m.model === entry.model && !host.fixed(m));
        if (saved) this.#saved = await host.save({ ...entry, contextWindow: window });
      })
      .catch(() => undefined)
      .finally(() => this.render());
  }

  #sessionsHost(): SessionsHost {
    const s = this.#session;
    return {
      dir: s ? dirname(s.path) : sessionDir(this.#cwd),
      current: s ? { id: s.meta.id, context: this.#tokens.context, window: this.#window } : undefined,
      resume: this.#resumeOf
        ? (path) => {
            this.#closeMenu();
            void this.#resumeSession(path).then(() => this.render());
          }
        : undefined,
      width: () => this.#width,
      open: (page) => {
        this.#menu.open(page);
        this.render();
      },
      swap: (from, to) => {
        this.#menu.swap(from, to);
        this.render();
      },
    };
  }

  /** Moves the session head back one message; a fork is only ever a pointer move. */
  /** /clear: the screen and the terminal's scrollback go; the conversation stays as it was. */
  #clearScreen(): void {
    this.#marker = "";
    this.#renderer.update(this.#state());
    this.#renderer.clear();
    this.#printedAny = false;
  }

  /** /new: a new session, the model with no history; counters and plan start again. */
  async #newSession(): Promise<void> {
    if (this.#running) {
      this.#marker = "a run is going: Esc it first, then /new";
      return;
    }
    if (this.#newSessionOf === undefined) {
      this.#marker = "/new is not available here";
      return;
    }
    const { session, intro } = await this.#newSessionOf();
    this.#session = session;
    this.#tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
    this.#cost = 0;
    this.#queued = [];
    this.#side.history([]);
    this.#clearScreen();
    this.intro(intro);
    this.#marker = this.#quiet = "new session: the model starts with no history";
  }

  /** /sessions' R: that session's conversation, in place of this one (the model in use stays). */
  async #resumeSession(path: string): Promise<void> {
    if (this.#running) {
      this.#marker = "a run is going: Esc it first, then resume";
      return;
    }
    const { session, intro } = (await this.#resumeOf?.(path)) ?? {};
    if (session === undefined || intro === undefined) return;
    this.#session = session;
    this.#tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
    this.#cost = 0;
    this.#queued = [];
    this.#clearScreen();
    this.intro(intro);
    this.replay(this.#agent.messages, `resumed session ${session.meta.id}`);
    this.#marker = this.#quiet = "resumed: the model has that conversation again";
  }

  async #forkHead(): Promise<string> {
    const session = this.#session;
    if (session === undefined) return "fork: no session to fork";
    const branch = session.activeBranch();
    const head = branch.at(-1);
    if (head === undefined) return "fork: the session is empty";
    const target = branch.at(-2) ?? head;
    if (target.id === head.id) return "fork: already at the oldest message of this branch";
    await session.setHead(target.id);
    if (this.#rebuild) this.#agent = this.#rebuild();
    return `fork: head moved from ${head.role} to ${target.role} (${branch.length} -> ${branch.length - 1} messages)`;
  }
}

/** The plan as transcript rows, for a window too narrow for the side column. */
function planLines(todos: Todo[]): string {
  const marks = { done: `${ANSI.dim}✓`, in_progress: `${ANSI.toolDot}●${ANSI.reset}${ANSI.bold}`, pending: "○" };
  const done = todos.filter((t) => t.status === "done").length;
  return [`${ANSI.bold}Plan${ANSI.reset} ${ANSI.dim}${done}/${todos.length}${ANSI.reset}`, ...todos.map((t) => `${marks[t.status]} ${t.text}${ANSI.reset}`)].join("\n");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The [Capabilities] lines of a panel: the header to the next blank line (at -1: none). */
/** The panel's head through its [Capabilities] lines: the mushroom (its face is the profile's) and
 *  what is on, all that changes when something is switched. */
function capabilitiesSection(text: string): { lines: string[]; at: number; end: number } {
  const lines = text.split("\n");
  const caps = lines.findIndex((line) => line.includes("[Capabilities]"));
  const end = lines.indexOf("", caps + 1);
  return { lines, at: caps < 0 ? -1 : 0, end: end < 0 ? lines.length : end };
}

/** `panel` with its [Capabilities] lines taken from `fresh`. */
export function withCapabilities(panel: string, fresh: string): string {
  const old = capabilitiesSection(panel);
  const now = capabilitiesSection(fresh);
  if (old.at < 0 || now.at < 0) return panel;
  return [...old.lines.slice(0, old.at), ...now.lines.slice(now.at, now.end), ...old.lines.slice(old.end)].join("\n");
}
