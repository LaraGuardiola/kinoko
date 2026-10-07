// The TUI wired to the Agent. This is where interruption becomes real: the editor keeps typing
// while the model streams, Enter steers, Alt+Enter follows up, Esc cuts the run, and anything the
// user typed while it was cut comes back.
//
// Only the live region is repainted; finished messages and tool blocks are printed above it, so the
// native scrollback keeps the history.

import { KeyParser } from "./term.ts";
import type { Key } from "./term.ts";
import { Editor } from "./editor.ts";
import { Renderer } from "./render.ts";
import { renderMarkdown } from "./markdown.ts";
import { ABORTED, HELP, STREAM_ROWS, liveRegion, oneLine, overflow, statusLine, toolBlock, wrapTo } from "./view.ts";
import { actionFor } from "./keys.ts";
import type { QueuedView, ToolView } from "./view.ts";
import type { Agent, RunResult } from "../loop.ts";
import type { AgentEvent } from "../loop.ts";
import type { Session } from "../session.ts";
import type { Message } from "../types.ts";



export interface AppOptions {
  agent: Agent;
  write: (text: string) => void;
  /** 0-based model id shown in the status line. */
  model: string;
  contextWindow: number;
  viewportRows?: number;
  viewportCols?: number;
  reservedRows?: number;
  viewportHeight?: () => number;
  viewportTop?: () => number;
  session?: Session;
  /** Called by /quit. The demo and the CLI pass the process exit. */
  onQuit?: () => void;
  /** Rebuilds the agent after /fork moved the session head. */
  rebuild?: () => Agent;
}

export class App {
  #agent: Agent;
  #renderer: Renderer;
  #parser = new KeyParser();
  #editor: Editor;
  #model: string;
  #window: number;
  #viewportRows: number | undefined;
  #viewportCols: number | undefined;
  #reservedRows: number;
  #session: Session | undefined;
  #rebuild: (() => Agent) | undefined;
  #onQuit: (() => void) | undefined;

  #running = false;
  #stream = ""; // assistant text still streaming
  #thinking = ""; // model reasoning, never sent back to the provider
  #transcript: Array<{ role: "user" | "assistant" | "thinking"; text: string }> = [];
  #tool: ToolView | undefined;
  #queued: QueuedView[] = [];
  #toolBlocksFull = false; // ctrl+t
  #marker = ""; // one-line note above the editor ("Interrupted", "Compacted", ...)
  #tokens = { input: 0, output: 0, cacheRead: 0 };
  #cost = 0;
  #flushed = 0; // transcript head rows already moved to the scrollback

  constructor(opts: AppOptions) {
    this.#agent = opts.agent;
    this.#renderer = new Renderer({
      write: opts.write,
      columns: () => this.#viewportCols ?? 80,
      rows: opts.viewportHeight,
      topRow: opts.viewportTop,
    });
    this.#editor = new Editor();
    this.#model = opts.model;
    this.#window = opts.contextWindow;
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#reservedRows = opts.reservedRows ?? 0;
    this.#session = opts.session;
    this.#rebuild = opts.rebuild;
    this.#onQuit = opts.onQuit;
    this.#agent.on((e) => this.#onAgentEvent(e));
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
  }

  /** Updates the available terminal height after a resize. */
  resize(cols: number, rows: number): void {
    this.#viewportCols = cols;
    this.#viewportRows = Math.max(2, rows - this.#reservedRows);
    this.render();
  }

  // ---- what the tests and the CLI read ----
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
      case "submit":
        void this.#submit();
        return;
      case "follow-up":
        this.#followUp();
        return;
      case "editor": {
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
      if (!(await this.command(text))) this.#printAbove(`unknown command ${text}: try /help`);
      this.render();
      return;
    }
    this.#editor.remember(text);
    this.#editor.clear();
    this.#marker = "";
    if (this.#agent.state === "running") {
      // Already running: this is a steer. queue_change updates the queued area.
      this.#echoUser(text);
      this.#agent.steer(text);
      this.render();
      return;
    }
    this.#running = true;
    this.#stream = "";
    this.#thinking = "";
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
      this.#echoUser(text);
      this.#agent.followUp(text);
      this.render();
      return;
    }
    this.#stream = "";
    this.#thinking = "";
    this.#echoUser(text);
    void this.#run(text);
  }

  async #run(text: string): Promise<void> {
    await this.#agent.prompt(text);
    this.#running = false;
    this.render();
  }

  #quit(): void {
    this.#onQuit?.();
  }

  /** Alt+Up: pull the newest queued message back into the editor. */
  #pullQueued(): void {
    const last = this.#queued.pop();
    if (last === undefined) return;
    const current = this.#editor.text.trim();
    this.#editor.setText(current === "" ? last.text : `${last.text}\n${current}`);
    this.render();
  }

  // ---- agent events ----

  #onAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "message_delta":
        this.#stream += e.delta;
        return;
      case "thinking_delta":
        this.#thinking += e.delta;
        return;
      case "tool_start":
        this.#tool = {
          name: e.call.name,
          args: oneLine(JSON.stringify(e.call.args ?? {})),
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
        return;
      case "message_end":
        this.#finishMessage(e.message);
        return;
      case "queue_change":
        this.#syncQueued(e.steer, e.followUp);
        return;
      case "compacted":
        this.#marker = "compacted: full prompt re-read expected";
        return;
      case "run_end":
        this.#finishRun(e.reason, e.dropped);
        return;
      default:
        return;
    }
  }

  /** Finalized assistant text: keep what is on screen, print the rest above it. */
  #finishMessage(message: Message): void {
    const usage = message.usage;
    if (usage) {
      this.#tokens.input += usage.input ?? 0;
      this.#tokens.output += usage.output ?? 0;
      this.#tokens.cacheRead += usage.cacheRead ?? 0;
      this.#cost += usage.cost ?? 0;
    }
    const thinking = message.thinking ?? this.#thinking;
    if (thinking.trim() !== "") this.#transcript.push({ role: "thinking", text: thinking });
    this.#thinking = "";
    if (this.#stream.trim() !== "") {
      // Text that no longer fits moves up into the scrollback instead of the region.
      const spilled = overflow(this.#stream);
      if (spilled !== "") this.#printAbove(renderMarkdown(spilled));
      const rows = this.#stream.split("\n");
      this.#stream = rows.length <= STREAM_ROWS ? this.#stream : rows.slice(-STREAM_ROWS).join("\n");
    }
    this.render();
  }

  #printTool(): void {
    const tool = this.#tool;
    if (!tool) return;
    this.#tool = undefined;
    this.#printAbove(toolBlock(tool, this.#toolBlocksFull));
  }

  #finishRun(reason: RunResult["reason"], dropped: string[] | undefined): void {
    this.#running = false;
    this.#queued = [];
    if (this.#stream.trim() !== "") {
      this.#transcript.push({ role: "assistant", text: this.#stream });
      this.#stream = "";
    }
    if (dropped !== undefined && dropped.length > 0) {
      // Nothing the user typed is ever lost: it goes back into the editor.
      const back = dropped.join("\n");
      const current = this.#editor.text.trim();
      this.#editor.setText(current === "" ? back : `${back}\n${current}`);
      this.#marker = "Interrupted — your queued messages are back in the editor";
    } else if (reason === "aborted") {
      this.#marker = "Interrupted";
    }
    this.render();
  }

  #syncQueued(steer: string[], followUp: string[]): void {
    this.#queued = [
      ...steer.map((text) => ({ kind: "steer" as const, text: text })),
      ...followUp.map((text) => ({ kind: "followUp" as const, text: text })),
    ];
    this.render();
  }

  #printAbove(text: string): void {
    this.#renderer.update(this.#state());
    this.#renderer.printAbove(text);
  }

  #echoUser(text: string): void {
    this.#transcript.push({ role: "user", text: text });
    this.render();
  }

  // ---- the live region ----

  #state(): { lines: string[]; row: number; col: number } {
    const editorWidth = Math.max(1, (this.#viewportCols ?? 80) - 4);
    const view = this.#editor.view(wrapTo(editorWidth));
    const region = liveRegion({
      transcript: this.#transcript,
      stream: this.#stream,
      thinking: this.#thinking,
      tool: this.#tool,
      marker: this.#marker,
      queued: this.#queued,
      editorLines: view.lines,
      editorEmpty: this.#editor.empty,
      editorRow: view.row,
      editorCol: view.col,
      status: this.statusLine,
      viewportRows: this.#viewportRows,
      viewportCols: this.#viewportCols,
    });
    // Trimmed transcript rows move to the scrollback once, in order, so every
    // chat stays reachable by scrolling up. The transcript prefix is append-only,
    // so a running count never prints a row twice.
    if (region.dropped.length > this.#flushed) {
      const newly = region.dropped.slice(this.#flushed);
      this.#flushed = region.dropped.length;
      const frame = { lines: region.lines, row: region.row, col: region.col };
      this.#renderer.update(frame);
      this.#renderer.printAbove(newly.join("\n"));
      return frame;
    }
    return region;
  }

  // ---- slash commands ----

  /** Runs a slash command. Returns false when the name is unknown. */
  async command(input: string): Promise<boolean> {
    const [name = ""] = input.replace(/^\//, "").split(" ");
    switch (name) {
      case "help":
        this.#printAbove(HELP);
        this.render();
        return true;
      case "model":
        this.#printAbove(`model: ${this.#model}  context: ${this.#window} tokens`);
        this.render();
        return true;
      case "compact": {
        const done = await this.#agent.compactNow();
        this.#marker = done ? "compacted: full prompt re-read expected" : "nothing to compact yet";
        this.render();
        return true;
      }
      case "fork": {
        const moved = await this.#forkHead();
        this.#printAbove(moved);
        this.render();
        return true;
      }
      case "quit":
        this.#quit();
        return true;
      default:
        return false;
    }
  }

  /** Moves the session head back one message; a fork is only ever a pointer move. */
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
