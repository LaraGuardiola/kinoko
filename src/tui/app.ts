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
import { formatBlock, liveRegion, statusLine, wrapTo } from "./view.ts";
import type { Todo } from "./todos.ts";
import { replayBlocks } from "./replay.ts";
import { approvalKey, approvalRows } from "./approval.ts";
import type { ApprovalView } from "./approval.ts";
import { Menu } from "./menu.ts";
import type { ListPage, MenuItem } from "./menu.ts";
import { copyText } from "./clipboard.ts";
import { THINKING, copyPage, helpText, profileLabel, sessionLines, thinkingPage } from "./menu-pages.ts";
import { snippets } from "./snippets.ts";
import type { ThinkingProfile } from "./menu-pages.ts";
import type { CommandHost } from "../commands.ts";
import type { Catalog, Change } from "../catalog.ts";
import { actionFor } from "./keys.ts";
import type { QueuedView, Region } from "./view.ts";
import type { Agent } from "../loop.ts";
import type { Session } from "../session.ts";
import type { Image, Message } from "../types.ts";
import { modelName } from "../prompt.ts";
import { ImageRegistry, clipboardImage, imageFromFile, imagePathOf } from "./images.ts";
import { FilePicker } from "./files.ts";
import { compactingNote } from "./sprout.ts";
import { ANSI, cells, stripAnsi } from "./style.ts";
import { Marker } from "./marker.ts";
import { Scrollback } from "./scrollback.ts";
import { ModelSwitch } from "./model-switch.ts";
import { StartupPanel } from "./startup-panel.ts";
import { ExtensionsMenu } from "./extensions-menu.ts";
import { RunView } from "./run-view.ts";
import { SessionActions } from "./session-actions.ts";
import { SlashMenu } from "./slash-menu.ts";
import type { ModelsHost } from "./model-switch.ts";
import { COPY, copyFor } from "./code.ts";
import { SidePanel } from "./side.ts";
import type { ChangesSource } from "./side.ts";
import { openIntegrations } from "./integrations-menu.ts";
import { openSessions } from "./sessions-menu.ts";
import { jobsLabel, openJobs } from "./jobs-view.ts";
import type { Jobs } from "../jobs.ts";
import type { IntegrationsHost } from "./integrations-menu.ts";
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
  /** The messages sent in earlier runs (↑ brings them back), and where to keep each new one. */
  history?: { sent: string[]; add: (text: string) => void };
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

export type { ModelsHost } from "./model-switch.ts";

export class App {
  #agent: Agent;
  #renderer: Renderer;
  #scrollback: Scrollback;
  #startup: StartupPanel;
  #extensions: ExtensionsMenu;
  #parser = new KeyParser();
  #editor: Editor;
  #thinking: string | undefined;
  #profile: string | undefined;
  #budgets: boolean;
  #menu = new Menu();
  #slash: SlashMenu;
  #models: ModelSwitch;
  #catalogs: { extensions?: Catalog; skills?: Catalog };
  #apply: AppOptions["apply"];
  #jobs: Jobs | undefined;
  #extensionCommands: AppOptions["extensionCommands"];
  #viewportRows: number | undefined;
  #viewportCols: number | undefined;
  #onQuit: (() => void) | undefined;
  #handOver: AppOptions["handOver"];
  #placeOf: (() => Promise<string>) | undefined;
  #place = "";
  #images = new ImageRegistry();
  #clipboard: (signal: AbortSignal) => Promise<Image | string>;
  #cwd: string;
  #files: FilePicker;
  #side: SidePanel;
  #integrations: AppOptions["integrations"];

  #marker = new Marker(); // the one-line note above the editor
  #run: RunView; // what the run in progress shows
  #sessions: SessionActions;

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
    this.#scrollback = new Scrollback({ renderer: this.#renderer, state: () => this.#state(), columns: () => this.#printCols });
    this.#startup = new StartupPanel({ scrollback: this.#scrollback, renderer: this.#renderer, current: opts.capabilities, render: () => this.render() });
    this.#editor = new Editor({ history: opts.history?.sent, onRemember: opts.history?.add });
    this.#thinking = opts.thinking;
    this.#profile = opts.thinkingProfile;
    this.#budgets = opts.budgets ?? false;
    this.#catalogs = { extensions: opts.extensions, skills: opts.skills };
    // Every install, removal or switch also brings the [Capabilities] lines up to date.
    const apply = opts.apply;
    this.#apply = apply && (async (kind, name, change) => {
      const done = await apply(kind, name, change);
      await this.#startup.refresh();
      return done;
    });
    this.#jobs = opts.jobs;
    this.#extensionCommands = opts.extensionCommands;
    this.#jobs?.on(() => this.render()); // the label counts them
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#models = new ModelSwitch({
      agent: () => this.#agent,
      host: opts.models,
      model: opts.model,
      contextWindow: opts.contextWindow,
      noModel: opts.noModel === true,
      menu: this.#menu,
      marker: this.#marker,
      session: () => this.#sessions.session,
      closeMenu: () => this.#slash.close(),
      render: () => this.render(),
    });
    this.#onQuit = opts.onQuit;
    this.#handOver = opts.handOver;
    this.#placeOf = opts.place;
    this.#clipboard = opts.clipboard ?? ((signal) => clipboardImage(signal));
    this.#cwd = opts.cwd ?? process.cwd();
    this.#files = new FilePicker(this.#cwd, () => this.render());
    this.#side = new SidePanel(this.#cwd, () => this.render(), opts.changes);
    this.#slash = new SlashMenu({
      menu: this.#menu,
      editor: this.#editor,
      files: this.#files,
      extensionCommands: () => this.#extensionCommands?.list() ?? [],
      regionTop: () => this.#renderer.top,
      regionRows: () => this.#state().lines.length,
      hasPlace: () => this.#place !== "",
      openRoot: (item) => this.#openRoot(item),
      closed: () => this.#startup.menuClosed(),
      render: () => this.render(),
    });
    this.#integrations = opts.integrations;
    this.#extensions = new ExtensionsMenu({
      catalogs: this.#catalogs,
      apply: this.#apply,
      home: this.#integrations?.home ?? userHome(),
      menu: this.#menu,
      marker: this.#marker,
      commandHost: () => this.commandHost(),
      changed: () => this.#startup.refresh(),
      render: () => this.render(),
    });
    this.#run = new RunView({
      scrollback: this.#scrollback,
      marker: this.#marker,
      side: this.#side,
      columns: () => this.#viewportCols,
      printColumns: () => this.#printCols,
      sideOn: () => this.#sideOn,
      giveBack: (text) => this.#takeBack([text]),
      refreshPlace: () => this.#refreshPlace(),
      render: () => this.render(),
    });
    this.#agent.on((e) => this.#run.onEvent(e));
    this.#sessions = new SessionActions({
      session: opts.session,
      create: opts.newSession,
      load: opts.resumeSession,
      rebuild: opts.rebuild,
      agent: () => this.#agent,
      replaceAgent: (agent) => (this.#agent = agent),
      cwd: this.#cwd,
      run: this.#run,
      side: this.#side,
      marker: this.#marker,
      menu: this.#menu,
      contextWindow: () => this.#models.contextWindow,
      width: () => this.#scrollback.width,
      clearScreen: () => this.#clearScreen(),
      intro: (text) => this.intro(text),
      replay: (messages, note) => this.replay(messages, note),
      closeMenu: () => this.#slash.close(),
      render: () => this.render(),
    });
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
    if (this.#scrollback.held) return;
    this.#renderer.update(this.#state());
    this.#renderer.frame();
    const menuOpen = this.#slash.showing;
    if (menuOpen !== this.#mouse) {
      this.#mouse = menuOpen;
      // 1003: every motion too, so hovering an item selects it; 1000: clicks only. Turning 1003 off
      // turns tracking off altogether, so 1000 comes after it.
      this.#write(menuOpen ? "\x1b[?1003h\x1b[?1006h" : "\x1b[?1003l\x1b[?1000h\x1b[?1006h");
    }
  }

  /** A resumed session: its conversation goes to the scrollback, and the context counter is back. */
  replay(messages: Message[], note: string): void {
    this.#scrollback.print("system", note);
    for (const block of replayBlocks(messages, this.#printCols)) this.#scrollback.print(block.kind, block.text, undefined, undefined, block.render && ((w) => block.render!(w + 2)));
    this.#images.startAfter(messages.reduce((n, m) => n + (m.images?.length ?? 0), 0));
    this.#side.history(messages);
    this.#run.count(messages);
    this.render();
  }

  /** Prints the startup panel above the region; what follows it is spaced like any other block. */
  intro(text: string, gap = false): void {
    this.#startup.print(text, gap);
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
    return this.#run.approval;
  }

  get queued(): QueuedView[] {
    return this.#run.queued.map((q) => ({ ...q }));
  }

  get running(): boolean {
    return this.#run.running;
  }

  get marker(): string {
    return this.#marker.text;
  }

  /** The cwd/branch line under the editor, as it stands now (not as last painted). */
  get place(): string {
    return this.#place;
  }

  get statusLine(): string {
    return statusLine({
      running: this.#run.running,
      model: this.#models.noModel ? "no model yet" : this.#models.model,
      tokens: this.#run.tokens,
      contextWindow: this.#models.contextWindow,
      cost: this.#run.cost,
    });
  }

  // ---- input ----

  handleKey(key: Key): void {
    if (this.#scrollback.held) return; // the shell has the keyboard (a stray SIGINT included)
    // The terminal answering the size query: the side panel may come or go.
    if (key.name === "size-report" || key.name === "cursor-report") {
      if (key.size) this.#side.size(key.size);
      if (key.at) this.#renderer.position(key.at.row);
      this.#renderer.update(this.#state());
      this.#renderer.flush();
      return;
    }
    if (key.name === "mouse") {
      if (this.#mouse) this.#slash.mouse(key);
      else if (key.mouse?.press && key.mouse.button === 0 && key.mouse.wheel === undefined && !this.#clickJobs(key.mouse.x, key.mouse.y)) this.#clickCopy(key.mouse.x, key.mouse.y);
      return;
    }
    // An approval waiting takes its keys first (Esc denies it); ctrl-c still aborts the run.
    const approval = this.#run.approval;
    if (approval !== undefined && key.name !== "ctrl-c") {
      const answer = approvalKey(key);
      if (answer !== undefined) this.#agent.approve(approval.id, answer.allow, { by: "tui", remember: answer.remember });
      return;
    }
    // An open menu takes its keys first: arrows, Enter, Esc (which must not abort a run there).
    if (this.#slash.key(key)) return;
    if (this.#planKey(key)) return;
    const action = actionFor(key, {
      running: this.#run.running || this.#agent.state === "running",
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
        this.#run.toggleFullTools();
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
      if (!(await this.command(text))) this.#scrollback.print("system", `unknown command ${text}: try /help`);
      this.render();
      return;
    }
    // No model yet: what was typed stays, and /models opens to set one up.
    if (this.#models.noModel) {
      this.#models.open();
      this.render();
      return;
    }
    this.#editor.remember(text);
    this.#editor.clear();
    this.#marker.clear();
    if (this.#agent.state === "running") {
      // Already running: this is a steer. It shows in the queued area until it reaches the model
      // ("delivered"), and only then joins the transcript.
      this.#agent.steer(text, this.#images.attached(text));
      this.render();
      return;
    }
    this.#run.started();
    this.#run.echoUser(text);
    void this.#send(text);
  }

  /** Alt+Enter: follow-up when running, plain submit when idle. */
  #followUp(): void {
    const text = this.#editor.text.trim();
    if (text === "") return;
    this.#editor.remember(text);
    this.#editor.clear();
    this.#run.started();
    this.#marker.clear();
    if (this.#agent.state === "running") {
      this.#agent.followUp(text, this.#images.attached(text));
      this.render();
      return;
    }
    this.#run.echoUser(text);
    void this.#send(text);
  }

  async #send(text: string): Promise<void> {
    await this.#agent.prompt(text, this.#images.attached(text));
    this.#run.stopped();
    this.render();
  }

  /**
   * The terminal lent to the user's shell: `command` run there (`!ls`), or an interactive shell
   * until it exits (/shell). What it prints stays above; kinoko comes back below it. Not during a
   * run: its output would land in the middle of the shell's.
   */
  async #shell(command: string): Promise<void> {
    this.#slash.close();
    if (this.#handOver === undefined) {
      this.#marker.warn("no terminal to lend here");
      this.render();
      return;
    }
    if (this.#run.running) {
      this.#marker.warn("a run is going: Esc it first, then the shell");
      this.render();
      return;
    }
    this.#marker.clear();
    this.#scrollback.print("system", command ? `${ANSI.dim}!${ANSI.reset} ${command}` : `${ANSI.dim}your shell: exit (or Ctrl-D) comes back to kinoko${ANSI.reset}`);
    this.#renderer.update(this.#state());
    this.#renderer.flush();
    this.#scrollback.hold();
    this.#renderer.suspend();
    const code = await this.#handOver(command).catch(() => -1);
    this.#renderer.resume();
    // The shell turned the mouse off: clicks (⧉, the jobs label) are kinoko's again.
    this.#mouse = false;
    this.#write("\x1b[?1000h\x1b[?1006h");
    this.#scrollback.release();
    if (code !== 0) this.#marker.warn(`${command ? "the command" : "the shell"} exited with ${code}`);
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
    if (typeof image === "string") this.#marker.warn(`Image not attached: ${image}`);
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

  // ---- the live region ----

  #refreshPlace(): void {
    void this.#placeOf?.()
      .then((place) => {
        this.#place = place;
        this.render();
      })
      .catch(() => undefined);
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
    const { compacting, approval } = this.#run;
    return liveRegion({
      open: this.#scrollback.open,
      tools: this.#run.toolLines(),
      // Until the result is in, the bullet fades in and out (the render timer repaints each step).
      pulse: this.#run.pulse(),
      toolGap: this.#scrollback.printedAny,
      // While compacting: mushrooms and how far it is (the clock moves them on each frame).
      marker: compacting ? compactingNote(compacting, Date.now()) : this.#marker.text,
      markerAlert: !compacting && this.#marker.tone === "alert",
      markerCream: compacting !== undefined || this.#marker.tone === "info",
      queued: this.#run.queued,
      approval: approval === undefined ? undefined : approvalRows(approval),
      editorLines: view.lines,
      editorRow: view.row,
      editorCol: view.col,
      status: this.statusLine,
      place: this.#place,
      thinking: this.#thinking,
      jobs: jobsLabel(this.#jobs?.running ?? 0),
      menu: this.#slash.rows(),
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
        this.#scrollback.print("system", helpText(this.#scrollback.width), undefined, undefined, (w) => helpText(w));
        this.render();
        return true;
      case "model":
        this.#scrollback.print("system", `model: ${modelName(this.#models.model)}  context: ${this.#models.contextWindow} tokens`);
        this.render();
        return true;
      case "compact": {
        const done = await this.#agent.compactNow();
        if (!done) this.#marker.warn("nothing to compact yet");
        this.render();
        return true;
      }
      case "fork": {
        const moved = await this.#sessions.fork();
        this.#scrollback.print("system", moved);
        this.render();
        return true;
      }
      case "clear":
        this.#clearScreen();
        this.render();
        return true;
      case "new":
        await this.#sessions.startNew();
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
    if (this.#models.noModel) this.#scrollback.print("system", NO_MODEL);
    this.render();
  }

  /** At start: says so when the model in use is not one its endpoint serves (see model-check.ts). */
  async checkModel(): Promise<void> {
    const note = await this.#models.mismatch();
    if (note === undefined) return;
    const block = (width: number): string => `${ANSI.cream}${formatBlock("system", note, width)}${ANSI.reset}`;
    this.#scrollback.print("system", block(this.#scrollback.width), this.#scrollback.printedAny, undefined, block); // wrapped by words, again on a resize
    this.render();
  }

  /** An extension's command: what it answers, printed here; one that throws says so. */
  async #extensionCommand(name: string, args: string): Promise<boolean> {
    const run = this.#extensionCommands?.get(name);
    if (run === undefined) return false;
    this.#scrollback.print("system", `${ANSI.dim}/${name}${args ? ` ${args}` : ""}…${ANSI.reset}`);
    this.render();
    const answer = await Promise.resolve()
      .then(() => run(args))
      .catch((e: unknown) => `/${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    this.#scrollback.print("system", answer);
    this.render();
    return true;
  }

  // ---- the slash menu ----

  /**
   * Ctrl+O unfolds the plan over the side column (or prints it, when the window is too narrow for
   * the column); unfolded, the arrows, PgUp/PgDn and Home/End scroll it by tasks and Esc folds it.
   */
  #planKey(key: Key): boolean {
    const column = this.#side.column(this.#viewportCols);
    if (key.name === "ctrl-o") {
      if (column !== undefined) this.#side.toggle();
      else if (this.#side.todos.length === 0) this.#marker.warn("no plan yet");
      else this.#scrollback.print("system", planLines(this.#side.todos));
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
        this.#marker.inform(text);
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
        this.#marker.inform(text);
        this.render();
      },
      changed: () => void this.#startup.refresh(),
      hubRunning: this.#integrations?.hubRunning ?? (() => hubRunning(hubSocket(home))),
      filesExtension: this.#integrations?.filesExtension ?? this.#extensions.telegram(),
    };
  }

  #openRoot(item: MenuItem): void {
    if (item.name === "thinking") this.#menu.open(this.#thinkingPage());
    else if (item.name === "models") this.#models.open();
    else if (item.name === "extensions" || item.name === "skills") this.#extensions.openCatalog(item.name);
    else if (item.name === "sessions") openSessions(this.#sessions.menuHost());
    else if (item.name === "jobs") this.#openJobs();
    else if (item.name === "integrations") openIntegrations(this.#integrationsHost());
    else if (item.name === "profile") this.#extensions.openProfiles();
    else if (item.name === "copy") this.#menu.open(copyPage(snippets(this.#agent.messages), (s) => this.#copy(s.code)));
    else {
      this.#slash.close();
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
    this.#marker.inform(`copied: ${lines} line${lines === 1 ? "" : "s"}`);
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
    this.#marker.inform(`thinking: ${this.#thinking} from the next request`);
    return this.#marker.text;
  }

  /** What the phone's slash commands act on (through kinoko serve): this TUI, so its screen follows. */
  commandHost(): CommandHost {
    return {
      agent: this.#agent,
      ...(this.#jobs ? { jobs: this.#jobs } : {}),
      catalogs: this.#catalogs,
      apply: this.#apply,
      newSession: async () => {
        await this.#sessions.startNew();
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
        list: (signal) => this.#models.list(signal),
        set: (name) => {
          const note = this.#models.useByName(name);
          this.render();
          return note;
        },
      },
      clear: () => {
        this.#clearScreen();
        this.render();
      },
      fork: async () => {
        const moved = await this.#sessions.fork();
        this.#scrollback.print("system", moved);
        this.render();
        return moved;
      },
      session: () => {
        const s = this.#sessions.session;
        if (s === undefined) return "no session";
        const facts = { path: s.path, id: s.meta.id, created: s.meta.created, messages: this.#agent.messages, context: this.#run.tokens.context, window: this.#models.contextWindow };
        return stripAnsi(sessionLines(facts, 60).join("\n"));
      },
      told: (note) => {
        this.#marker.inform(note);
        void this.#startup.refresh(); // a profile switched from the phone: the panel says which
        this.render();
      },
    };
  }

  /** /clear: the screen and the terminal's scrollback go; the conversation stays as it was. */
  #clearScreen(): void {
    this.#marker.clear();
    this.#renderer.update(this.#state());
    this.#renderer.clear();
    this.#scrollback.cleared();
  }

}

/** The plan as transcript rows, for a window too narrow for the side column. */
function planLines(todos: Todo[]): string {
  const marks = { done: `${ANSI.dim}✓`, in_progress: `${ANSI.toolDot}●${ANSI.reset}${ANSI.bold}`, pending: "○" };
  const done = todos.filter((t) => t.status === "done").length;
  return [`${ANSI.bold}Plan${ANSI.reset} ${ANSI.dim}${done}/${todos.length}${ANSI.reset}`, ...todos.map((t) => `${marks[t.status]} ${t.text}${ANSI.reset}`)].join("\n");
}
