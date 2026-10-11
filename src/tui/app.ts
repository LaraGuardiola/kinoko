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
import { MENU_ROWS, Menu, filterRoot, listRows, listWindow, pageRows } from "./menu.ts";
import type { InfoPage, ListPage, MenuItem } from "./menu.ts";
import { ROOT, catalogPage, helpText, profileLabel, sessionLines, thinkingPage } from "./menu-pages.ts";
import type { Catalog, Entry, Outcome, Change } from "../catalog.ts";
import { endpointOf, endpointPage, hostOf, keyPage, labelPage, modelsPage, namePage, servedPage } from "./models-menu.ts";
import type { ModelChoice, ModelsView } from "./models-menu.ts";
import type { SavedModel } from "../config.ts";
import type { Served } from "../providers/openai-compat.ts";
import type { Provider } from "../types.ts";
import { actionFor } from "./keys.ts";
import type { BlockKind, OpenBlock, QueuedView, Region, ToolView } from "./view.ts";
import type { Agent, RunResult } from "../loop.ts";
import type { AgentEvent } from "../loop.ts";
import type { Session } from "../session.ts";
import type { Image, Message } from "../types.ts";
import { modelName } from "../prompt.ts";
import { ImageRegistry, clipboardImage, imageFromFile, imagePathOf } from "./images.ts";
import { FilePicker } from "./files.ts";
import { compactingNote } from "./sprout.ts";
import { ANSI } from "./style.ts";
import type { CompactProgress } from "../compact.ts";
import { SidePanel } from "./side.ts";
import type { ChangesSource } from "./side.ts";



export interface AppOptions {
  agent: Agent;
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
  viewportRows?: number;
  viewportCols?: number;
  /** The line under the editor (cwd and git branch). Re-read after every tool call: tools can
   *  create a repository or switch branch. */
  place?: () => Promise<string>;
  session?: Session;
  /** Called by /quit. The demo and the CLI pass the process exit. */
  onQuit?: () => void;
  /** /new: a new session for a new conversation, and the startup panel to print again. */
  newSession?: () => Promise<{ session: Session; intro: string }>;
  /** Rebuilds the agent after /fork moved the session head. */
  rebuild?: () => Agent;
  /** Reads the clipboard image for Ctrl+V (an Image, or why not). Tests pass a fake. */
  clipboard?: (signal: AbortSignal) => Promise<Image | string>;
  /** Where a pasted relative image path is read from, and git is asked about changes. */
  cwd?: string;
  /** The side panel's changes (git by default). Tests pass a fake. */
  changes?: ChangesSource;
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
  /** Entries that cannot be removed from the TUI (the configured model). */
  fixed: (entry: SavedModel) => boolean;
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
  #newSessionOf: AppOptions["newSession"];
  #endpoint: string;
  #saved: SavedModel[];
  #viewportRows: number | undefined;
  #viewportCols: number | undefined;
  #session: Session | undefined;
  #rebuild: (() => Agent) | undefined;
  #onQuit: (() => void) | undefined;
  #placeOf: (() => Promise<string>) | undefined;
  #place = "";
  #images = new ImageRegistry();
  #clipboard: (signal: AbortSignal) => Promise<Image | string>;
  #cwd: string;
  #files: FilePicker;
  #side: SidePanel;

  #running = false;
  // The block being streamed (thinking or answer).
  #open: OpenBlock | undefined;
  #thinkingSeen = false; // this message already streamed its thinking
  #printedAny = false; // something is already in the scrollback: every later block gets a blank row above
  #tool: ToolView | undefined;
  #pending: { name: string; args: string } | undefined; // a call the model is still writing
  #queued: QueuedView[] = [];
  #toolBlocksFull = false; // ctrl+t
  #compacting: CompactProgress | undefined; // a summary on its way: the note animates
  #marker = ""; // one-line note above the editor ("Interrupted", "Compacted", ...)
  #retrying = false; // the marker says a retry is coming: the next reply's first token clears it
  #quiet = ""; // a marker that only informs (an extension or skill installed or removed): cream, no background
  #tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
  #cost = 0;

  // The mouse is the terminal's (selecting, copying) except while the menu is open: then clicks
  // pick and the wheel moves through it.
  #mouse = false;
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
    this.#apply = opts.apply;
    this.#newSessionOf = opts.newSession;
    this.#endpoint = opts.models?.endpoint ?? "";
    this.#saved = opts.models?.saved ?? [];
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#session = opts.session;
    this.#rebuild = opts.rebuild;
    this.#onQuit = opts.onQuit;
    this.#placeOf = opts.place;
    this.#clipboard = opts.clipboard ?? ((signal) => clipboardImage(signal));
    this.#cwd = opts.cwd ?? process.cwd();
    this.#files = new FilePicker(this.#cwd, () => this.render());
    this.#side = new SidePanel(this.#cwd, () => this.render(), opts.changes);
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
    this.#renderer.update(this.#state());
    this.#renderer.frame();
    const menuOpen = this.#menu.page !== undefined || (this.#rootItems()?.length ?? 0) > 0;
    if (menuOpen !== this.#mouse) {
      this.#mouse = menuOpen;
      this.#write(menuOpen ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
    }
  }

  /** A resumed session: its conversation goes to the scrollback, and the context counter is back. */
  replay(messages: Message[], note: string): void {
    this.#print("system", note);
    for (const block of replayBlocks(messages, this.#printCols)) this.#print(block.kind, block.text);
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
  intro(text: string): void {
    this.#print("system", formatBlock("system", text, this.#width), false);
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
      model: this.#model,
      tokens: this.#tokens,
      contextWindow: this.#window,
      cost: this.#cost,
    });
  }

  // ---- input ----

  handleKey(key: Key): void {
    // The terminal answering the size query: the side panel may come or go.
    if (key.name === "size-report" || key.name === "cursor-report") {
      if (key.size) this.#side.size(key.size);
      if (key.at) this.#renderer.position(key.at.row);
      this.#renderer.update(this.#state());
      this.#renderer.flush();
      return;
    }
    if (key.name === "mouse") {
      this.#menuMouse(key);
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
    if (text.startsWith("/")) {
      this.#editor.clear();
      if (!(await this.command(text))) this.#print("system", `unknown command ${text}: try /help`);
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
      case "tool_pending":
        // The text before the call is final; the call itself shows at once, its bullet pulsing.
        this.#closeBlock();
        // Its name first, then what it acts on as soon as that arg is complete (a write's path).
        this.#pending = { name: e.name, args: e.args ? toolSummary(e.name, e.args, false) : "" };
        this.render();
        return;
      case "tool_start":
        this.#closeBlock();
        this.#pending = undefined;
        this.#side.toolCall(e.call);
        this.#tool = {
          name: e.call.name,
          args: toolSummary(e.call.name, e.call.args),
          output: "",
          aborted: false,
        };
        this.render();
        return;
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
        this.#pending = undefined;
        this.#thinkingSeen = false;
        this.#marker = `${e.error} · retry ${e.attempt}/${e.of} in ${Math.round(e.inMs / 1000)}s`;
        this.#retrying = true;
        this.render();
        return;
      case "first_token":
        if (this.#retrying) this.#marker = "";
        this.#retrying = false;
        return;
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
    // A call cut off before its args were complete never starts: drop its pulsing line.
    if (!message.toolCalls?.length) this.#pending = undefined;
    // A provider that only reports the reasoning at the end (no deltas): better late than lost.
    const thinking = message.thinking ?? "";
    if (!this.#thinkingSeen && thinking.trim() !== "") this.#print("thinking", formatBlock("thinking", thinking));
    this.#thinkingSeen = false;
    this.render();
  }

  #printTool(): void {
    const tool = this.#tool;
    if (!tool) return;
    this.#closeBlock();
    this.#tool = undefined;
    // With the side column on, the plan is there: its todo calls need no block in the transcript.
    if (tool.name === TODO_TOOL && !tool.aborted && !toolFailed(tool.output) && this.#sideOn) return;
    this.#print("tool", toolBlock(tool, this.#toolBlocksFull, this.#printCols));
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
    this.#pending = undefined;
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
      this.#print("tool", errorBlock(detail ?? "unknown error", this.#width));
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
    if (chunk !== "") this.#print(open.kind, chunk, gap);
  }

  /** Prints what is left of the open block and forgets it. */
  #closeBlock(): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const text = formatBlock(open.kind, open.text, this.#width);
    if (text !== "") this.#print(open.kind, text, open.gap);
  }

  /** Sends one finished piece to the scrollback. `gap` defaults to the usual blank row between blocks. */
  #print(kind: BlockKind, text: string, gap = this.#printedAny): void {
    if (text === "") return;
    // The renderer repaints the region right after the text: it has to know the current state.
    this.#renderer.update(this.#state());
    this.#renderer.printAbove(gap ? `\n${text}` : text);
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
    this.#print("user", formatBlock("user", text));
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
      tool: this.#tool ?? (this.#pending === undefined ? undefined : { ...this.#pending, output: "", aborted: false }),
      // Until the result is in, the bullet fades in and out (the render timer repaints each step).
      pulse: this.#tool || this.#pending !== undefined ? pulseLevel(Date.now()) : undefined,
      toolGap: this.#printedAny,
      // While compacting: mushrooms and how far it is (the clock moves them on each frame).
      marker: this.#compacting ? compactingNote(this.#compacting, Date.now()) : this.#marker,
      markerAlert: !this.#compacting && this.#marker.startsWith("Interrupted"),
      markerCream: this.#compacting !== undefined || this.#marker.startsWith("compacted") || (this.#quiet !== "" && this.#marker === this.#quiet),
      queued: this.#queued,
      editorLines: view.lines,
      editorRow: view.row,
      editorCol: view.col,
      status: this.statusLine,
      place: this.#place,
      thinking: this.#thinking,
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
        this.#print("system", helpText(this.#width));
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
      default:
        return false;
    }
  }

  // ---- the slash menu ----

  /** The root is open while the editor holds only a slash command being typed. */
  #rootItems(): MenuItem[] | undefined {
    if (this.#menu.page !== undefined || !/^\/\S*$/.test(this.#editor.text)) return undefined;
    return filterRoot(ROOT, this.#editor.text);
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
    } else if (page?.kind === "list" && page.update && key.name === "char" && key.char?.toLowerCase() === "u") {
      const item = page.items[this.#menu.index];
      if (item !== undefined && !item.header) page.update(item);
    } else if ((key.name === "up" || key.name === "down") && !key.alt) {
      this.#menu.arm(undefined); // moving away cancels a pending removal
      this.#menu.move(key.name === "up" ? -1 : 1, count, (i) => page?.kind === "list" && page.items[i]?.header === true);
    } else if (key.name === "escape") {
      // A page goes back to the root; the root closes, back to an empty input.
      if (!this.#menu.back()) this.#editor.clear();
    } else if (key.name === "enter" && !key.alt) {
      if (page?.kind === "list") {
        const item = page.items[this.#menu.index];
        if (item === undefined || item.header) return true;
        page.pick(item);
        // A pick that opened another page (add model) keeps the menu, as does a page that stays
        // (switching things on and off); any other pick is done.
        if (this.#menu.page === page && !page.stay) this.#closeMenu();
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
    if (!m.press || m.button !== 0) return;
    const top = this.#renderer.top;
    const page = this.#menu.page;
    const items = page?.kind === "list" ? page.items : page === undefined ? (this.#rootItems() ?? []) : undefined;
    if (top === undefined || items === undefined) return;
    // The menu sits at the region's foot: its rows, then the place line (if any), then the status.
    const rows = this.#state().lines.length;
    const menu = this.#menuRows().length;
    const end = top + rows - 1 - 1 - (this.#place ? 1 : 0);
    const row = m.y - (end - menu + 1) - (page === undefined ? 0 : 1); // a page's first row is its title
    const index = listWindow(items.length, this.#menu.index) + row;
    if (row < 0 || row >= Math.min(items.length, MENU_ROWS) || items[index] === undefined || items[index]?.header) return;
    this.#menu.select(index);
    this.#menuKey({ name: "enter" });
  }

  #closeMenu(): void {
    this.#menu.close();
    this.#editor.clear();
  }

  #openRoot(item: MenuItem): void {
    if (item.name === "thinking") this.#menu.open(this.#thinkingPage());
    else if (item.name === "models") this.#openModels();
    else if (item.name === "extensions" || item.name === "skills") this.#openCatalog(item.name);
    else if (item.name === "session") this.#menu.open(this.#sessionPage());
    else {
      this.#closeMenu();
      void this.command(`/${item.name}`).then(() => this.render());
    }
  }

  #thinkingPage(): ListPage {
    return thinkingPage(this.#profile, (profile) => {
      // Only an engine that takes a budget gets one; elsewhere the effort alone is the level.
      this.#agent.setThinking(profile.effort, this.#budgets ? profile.budget : undefined);
      this.#profile = profile.name;
      this.#thinking = profileLabel(profile, this.#budgets);
      this.#marker = `thinking: ${this.#thinking} from the next request`;
    });
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
    });
    const choose = (choice: ModelChoice): void => {
      if (choice.kind === "add") this.#addProvider();
      // The redrawn page becomes the one later answers refresh.
      else if (choice.kind === "remove") this.#removeModel(choice.entry, () => (page = modelsPage(view(), choose)));
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
      this.#menu.refresh(page, next);
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
        this.#marker = `removed ${modelName(entry.model)} at ${hostOf(entry.baseUrl)}`;
      })
      .catch(() => (this.#marker = `could not remove ${modelName(entry.model)}`))
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
          this.#marker = `model: ${modelName(entry.model)} at ${host}, saved`;
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
    if (entry.baseUrl !== this.#endpoint && this.#host) {
      this.#agent.setProvider(this.#host.connect(entry));
      this.#endpoint = entry.baseUrl;
    }
    this.#agent.setModel(entry.model);
    this.#model = entry.model;
    this.#marker = `model: ${modelName(entry.model)}${entry.baseUrl === "" ? "" : ` at ${hostOf(entry.baseUrl)}`} from the next request`;
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
   * Until then (or if it never says) the previous window stands, and the marker says so.
   */
  #learnWindow(entry: SavedModel): void {
    const host = this.#host;
    if (!host || entry.baseUrl === "") return;
    void host
      .discover(entry.baseUrl, entry.apiKey, AbortSignal.timeout(10_000))
      .then(async (served) => {
        const window = served.find((s) => s.id === entry.model)?.contextWindow;
        if (this.#model !== entry.model) return; // another pick came first
        if (!window) {
          this.#marker = `model: ${modelName(entry.model)} (its context window is unknown: keeping ${this.#window.toLocaleString("en-US")})`;
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

  #sessionPage(): InfoPage {
    const s = this.#session;
    if (s === undefined) return { kind: "info", title: "Session", lines: ["  no session"] };
    const facts = { path: s.path, id: s.meta.id, created: s.meta.created, messages: this.#agent.messages, context: this.#tokens.context, window: this.#window };
    return { kind: "info", title: "Session", lines: sessionLines(facts, this.#width) };
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
