// The TUI wired to the Agent. This is where interruption becomes real: the editor keeps typing
// while the model streams, Enter steers, Alt+Enter follows up, Esc cuts the run, and anything the
// user typed while it was cut comes back.
//
// Everything finished is printed above the live region, in the order it happened, so the native
// scrollback keeps the whole history and the terminal scrolls like in any other harness. The live
// region only holds the block being streamed, the running tool, the queue, the editor and the
// status line.
//
// App itself only wires the parts together, routes the keys and draws the region. The parts:
//   scrollback.ts       what is printed above, in order; the block being streamed
//   run-view.ts         the agent's events as the run shows them: tool rows, queue, approval
//   prompt-input.ts     where what you type goes: a prompt, a steer, a command, your shell
//   slash-menu.ts       the menu and the @ file list under the editor, their keys and mouse
//   slash-pages.ts      where each item of the menu leads
//   slash-commands.ts   /help, /model, /fork…; and what the phone's commands act on
//   model-switch.ts     the model in use, its endpoint and window; the /models page
//   extensions-menu.ts  /extensions, /skills, /profile
//   session-actions.ts  /new, resuming a session, /fork
//   startup-panel.ts    the panel at start, its [Capabilities] lines kept current
//   thinking-level.ts   how much the model thinks
//   marker.ts           the one-line note above the editor

import type { Jobs } from "../jobs.ts";
import type { Agent } from "../loop.ts";
import type { Message } from "../types.ts";
import { userHome } from "../home.ts";
import type { CommandHost } from "../commands.ts";
import type { AppOptions } from "./app-options.ts";
import { approvalKey, approvalRows } from "./approval.ts";
import type { ApprovalView } from "./approval.ts";
import { COPY, copyFor } from "./code.ts";
import { Editor } from "./editor.ts";
import { ExtensionsMenu } from "./extensions-menu.ts";
import type { Apply } from "./extensions-menu.ts";
import { FilePicker } from "./files.ts";
import { ImageRegistry, clipboardImage } from "./images.ts";
import { jobsLabel } from "./jobs-view.ts";
import { actionFor } from "./keys.ts";
import { Marker } from "./marker.ts";
import { Menu } from "./menu.ts";
import { ModelSwitch } from "./model-switch.ts";
import { PromptInput } from "./prompt-input.ts";
import { Renderer } from "./render.ts";
import type { RenderState } from "./render.ts";
import { replayBlocks } from "./replay.ts";
import { RunView } from "./run-view.ts";
import { Scrollback } from "./scrollback.ts";
import { SessionActions } from "./session-actions.ts";
import { SidePanel } from "./side.ts";
import { SlashCommands } from "./slash-commands.ts";
import { SlashMenu } from "./slash-menu.ts";
import { SlashPages } from "./slash-pages.ts";
import { compactingNote } from "./sprout.ts";
import { StartupPanel } from "./startup-panel.ts";
import { ANSI, cells, stripAnsi } from "./style.ts";
import { KeyParser } from "./term.ts";
import type { Key } from "./term.ts";
import { ThinkingLevel } from "./thinking-level.ts";
import type { Todo } from "./todos.ts";
import { formatBlock, liveRegion, statusLine, wrapTo } from "./view.ts";
import type { QueuedView, Region } from "./view.ts";

/** What a first run without any model says. */
const NO_MODEL = [
  "No model set up yet. Open /models and pick \"+ add provider\":",
  "  a local server (llama.cpp, Ollama, LM Studio: its URL, no key), or an API (its URL and key).",
  "kinoko lists what it serves; the one you pick is kept for the next start.",
].join("\n");

export type { AppOptions } from "./app-options.ts";
export type { ModelsHost } from "./model-switch.ts";

export class App {
  // The terminal: keys in, the live region and the scrollback out.
  #write: (text: string) => void;
  #parser = new KeyParser();
  #renderer: Renderer;
  #scrollback: Scrollback;
  #viewportRows: number | undefined;
  #viewportCols: number | undefined;
  // The mouse is kinoko's: a click on a code block's ⧉ copies it, and while the menu is open clicks
  // pick, hovering selects and the wheel moves through it. With Shift held the terminal has it
  // (scrolling the history, selecting text). undefined: not told to the terminal yet.
  #mouse: boolean | undefined;

  // What the live region shows, top to bottom.
  #run: RunView; // the run in progress: tool rows, queue, approval
  #marker = new Marker(); // the one-line note above the editor
  #editor: Editor;
  #thinking: ThinkingLevel; // on the rule above the editor
  #jobs: Jobs | undefined; // their count on the rule, too
  #menu = new Menu();
  #slash: SlashMenu; // the menu and the @ file list under the editor
  #placeOf: (() => Promise<string>) | undefined;
  #place = ""; // the cwd and branch, under the menu
  #side: SidePanel; // the plan and the changes, on the right when there is room
  #startup: StartupPanel;

  // What acts on all of that.
  #agent: Agent;
  #input: PromptInput;
  #commands: SlashCommands;
  #pages: SlashPages;
  #models: ModelSwitch;
  #sessions: SessionActions;
  #images = new ImageRegistry();
  #handOver: AppOptions["handOver"];
  #onQuit: (() => void) | undefined;
  #extKeys: AppOptions["extensionKeys"];
  /** What an extension says it is doing ("● listening"), at the start of the status line. */
  #extStatus: string | undefined;

  constructor(opts: AppOptions) {
    this.#agent = opts.agent;
    this.#write = opts.write;
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#handOver = opts.handOver;
    this.#onQuit = opts.onQuit;
    this.#extKeys = opts.extensionKeys;
    this.#placeOf = opts.place;
    this.#jobs = opts.jobs;
    const cwd = opts.cwd ?? process.cwd();
    const home = opts.integrations?.home ?? userHome();
    const render = (): void => this.render();

    // The screen.
    this.#renderer = new Renderer({
      write: opts.write,
      columns: () => this.#viewportCols ?? 80,
      rows: () => (this.#viewportRows ?? 23) + 1,
    });
    this.#scrollback = new Scrollback({ renderer: this.#renderer, state: () => this.#state(), columns: () => this.#printCols });
    this.#startup = new StartupPanel({ scrollback: this.#scrollback, renderer: this.#renderer, current: opts.capabilities, render });
    this.#editor = new Editor({ history: opts.history?.sent, onRemember: opts.history?.add });
    this.#side = new SidePanel(cwd, render, opts.changes);
    const files = new FilePicker(cwd, render);

    // The run, and what changes how the next one goes.
    this.#run = new RunView({
      scrollback: this.#scrollback,
      marker: this.#marker,
      side: this.#side,
      columns: () => this.#viewportCols,
      printColumns: () => this.#printCols,
      sideOn: () => this.#sideOn,
      giveBack: (text) => this.#input.takeBack([text]),
      refreshPlace: () => this.#refreshPlace(),
      render,
    });
    this.#agent.on((e) => this.#run.onEvent(e));
    this.#thinking = new ThinkingLevel({
      agent: () => this.#agent,
      label: opts.thinking,
      name: opts.thinkingProfile,
      budgets: opts.budgets ?? false,
      told: (note) => this.#marker.inform(note),
    });
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
      render,
    });
    this.#sessions = new SessionActions({
      session: opts.session,
      create: opts.newSession,
      load: opts.resumeSession,
      rebuild: opts.rebuild,
      agent: () => this.#agent,
      replaceAgent: (agent) => (this.#agent = agent),
      cwd,
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
      render,
    });

    // What is switched on: every install, removal or switch brings the [Capabilities] lines up to date.
    const catalogs = { extensions: opts.extensions, skills: opts.skills };
    const applyNow = opts.apply;
    const apply: Apply | undefined =
      applyNow &&
      (async (kind, name, change) => {
        const done = await applyNow(kind, name, change);
        await this.#startup.refresh();
        return done;
      });
    const extensions = new ExtensionsMenu({
      catalogs,
      apply,
      home,
      menu: this.#menu,
      marker: this.#marker,
      commandHost: () => this.commandHost(),
      changed: () => this.#startup.refresh(),
      render,
    });

    // What the user types, and the menu.
    this.#commands = new SlashCommands({
      agent: () => this.#agent,
      scrollback: this.#scrollback,
      marker: this.#marker,
      models: this.#models,
      sessions: this.#sessions,
      run: this.#run,
      thinking: this.#thinking,
      startup: this.#startup,
      extensionCommands: opts.extensionCommands,
      jobs: this.#jobs,
      catalogs,
      apply,
      clearScreen: () => this.#clearScreen(),
      quit: () => this.#quit(),
      shell: (command) => this.#shell(command),
      render,
    });
    this.#input = new PromptInput({
      agent: () => this.#agent,
      editor: this.#editor,
      images: this.#images,
      run: this.#run,
      marker: this.#marker,
      scrollback: this.#scrollback,
      models: this.#models,
      command: (text) => this.command(text),
      shell: (command) => this.#shell(command),
      clipboard: opts.clipboard ?? ((signal) => clipboardImage(signal)),
      cwd,
      render,
    });
    this.#slash = new SlashMenu({
      menu: this.#menu,
      editor: this.#editor,
      files,
      extensionCommands: () => opts.extensionCommands?.list() ?? [],
      regionTop: () => this.#renderer.top,
      regionRows: () => this.#state().lines.length,
      hasPlace: () => this.#place !== "",
      openRoot: (item) => this.#pages.open(item),
      closed: () => this.#startup.menuClosed(),
      render,
    });
    this.#pages = new SlashPages({
      agent: () => this.#agent,
      menu: this.#menu,
      slash: () => this.#slash,
      marker: this.#marker,
      thinking: this.#thinking,
      models: this.#models,
      extensions,
      sessions: this.#sessions,
      startup: this.#startup,
      jobs: this.#jobs,
      integrations: opts.integrations,
      home,
      // A jobs window fills what the menu may take: the screen less the input and its rules.
      room: () => ({ cols: (this.#printCols ?? 80) - 2, rows: Math.min(18, Math.max(3, (this.#viewportRows ?? 24) - 12)) }),
      command: (input) => this.command(input),
      write: this.#write,
      render,
    });

    this.#jobs?.on(render); // the label counts them
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
    const line = statusLine({
      running: this.#run.running,
      model: this.#models.noModel ? "no model yet" : this.#models.model,
      tokens: this.#run.tokens,
      contextWindow: this.#models.contextWindow,
      cost: this.#run.cost,
    });
    return this.#extStatus ? `${ANSI.cream}${this.#extStatus}${ANSI.reset}${ANSI.dim} | ${ANSI.reset}${line}` : line;
  }

  /** An extension speaking for the user (k.send): see PromptInput.send. */
  send(text: string, as: "prompt" | "steer_now"): boolean {
    return this.#input.send(text, as === "steer_now");
  }

  /** An extension's status line ("● listening"); undefined takes it away. */
  extensionStatus(text: string | undefined): void {
    if (text === this.#extStatus) return;
    this.#extStatus = text;
    this.render();
  }

  // ---- keys, the shell, quitting ----

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
    if (this.#extKeys?.press(key.name)) return;
    // Esc and Ctrl-C ask for quiet, a run going or not: an extension's voice stops with them.
    if (key.name === "escape" || key.name === "ctrl-c") this.#extKeys?.interrupt();
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
        this.#input.takeBack(this.#agent.unqueue("last"));
        return;
      case "send-now":
        // The reply being streamed is cut and the steer goes in now; nothing to cut: it waits.
        if (!this.#agent.sendNow()) this.render();
        return;
      case "cancel-queued":
        this.#input.takeBack(this.#agent.unqueue("all"));
        return;
      case "submit":
        void this.#input.submit();
        return;
      case "follow-up":
        this.#input.followUp();
        return;
      case "paste-image":
        void this.#input.pasteImage();
        return;
      case "editor": {
        if (key.name === "paste" && this.#input.pastedImage(key.char ?? "")) return;
        // Enter submits (a steer or a prompt: PromptInput decides); the rest edits.
        if (this.#editor.handle(key) === "submit") void this.#input.submit();
        this.render();
        return;
      }
      default:
        return;
    }
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
      thinking: this.#thinking.label,
      jobs: jobsLabel(this.#jobs?.running ?? 0),
      menu: this.#slash.rows(),
      tailCols,
      viewportRows: this.#viewportRows,
      viewportCols: cols,
    });
  }

  // ---- commands, and what is said at start ----

  /** Runs a slash command. Returns false when the name is unknown. */
  command(input: string): Promise<boolean> {
    return this.#commands.run(input);
  }

  /** What the phone's slash commands act on (through kinoko serve): this TUI, so its screen follows. */
  commandHost(): CommandHost {
    return this.#commands.phoneHost();
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

  // ---- the plan, clicks, /clear ----

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

  /** A click on the rule's jobs label opens their list. */
  #clickJobs(x: number, y: number): boolean {
    const label = jobsLabel(this.#jobs?.running ?? 0);
    const row = this.#renderer.rowAt(y);
    if (label === undefined || row === undefined) return false;
    const plain = [...cells(stripAnsi(row))].flatMap((c) => Array.from({ length: Math.max(1, c.width) }, () => c.text)).join("");
    const at = plain.indexOf(label.slice(2)); // past the gear, whose width terminals disagree on
    if (at < 0 || x < at - 1 || x > at + label.length + 1) return false;
    this.#editor.clear();
    this.#pages.openJobs();
    return true;
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
    this.#pages.copy(code);
    this.render();
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
