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
import { ABORTED, HELP, formatBlock, liveRegion, splitStable, statusLine, wrapTo } from "./view.ts";
import { toolBlock, toolSummary } from "./tools.ts";
import { actionFor } from "./keys.ts";
import type { BlockKind, OpenBlock, QueuedView, ToolView } from "./view.ts";
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
  /** The line under the editor (cwd and git branch). Re-read after every run: tools can switch branch. */
  place?: () => Promise<string>;
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
  #session: Session | undefined;
  #rebuild: (() => Agent) | undefined;
  #onQuit: (() => void) | undefined;
  #placeOf: (() => Promise<string>) | undefined;
  #place = "";

  #running = false;
  // The block being streamed (thinking or answer). Thinking is display-only, never sent back.
  #open: OpenBlock | undefined;
  #thinkingSeen = false; // this message already streamed its thinking
  #printedAny = false; // something is already in the scrollback (decides blank rows between blocks)
  #lastKind: BlockKind | undefined;
  #tool: ToolView | undefined;
  #queued: QueuedView[] = [];
  #toolBlocksFull = false; // ctrl+t
  #marker = ""; // one-line note above the editor ("Interrupted", "Compacted", ...)
  #tokens = { input: 0, output: 0, cacheRead: 0 };
  #cost = 0;

  constructor(opts: AppOptions) {
    this.#agent = opts.agent;
    this.#renderer = new Renderer({
      write: opts.write,
      columns: () => this.#viewportCols ?? 80,
    });
    this.#editor = new Editor();
    this.#model = opts.model;
    this.#window = opts.contextWindow;
    this.#viewportRows = opts.viewportRows;
    this.#viewportCols = opts.viewportCols;
    this.#session = opts.session;
    this.#rebuild = opts.rebuild;
    this.#onQuit = opts.onQuit;
    this.#placeOf = opts.place;
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
  }

  /** Updates the available terminal height after a resize. */
  resize(cols: number, rows: number): void {
    this.#viewportCols = cols;
    // The region has to stay shorter than the terminal, or its top could not be repainted.
    this.#viewportRows = Math.max(2, rows - 1);
    this.#renderer.update(this.#state());
    this.#renderer.flush();
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
      if (!(await this.command(text))) this.#print("system", `unknown command ${text}: try /help`);
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
    this.#echoUser(text);
    void this.#run(text);
  }

  async #run(text: string): Promise<void> {
    await this.#agent.prompt(text);
    this.#running = false;
    this.render();
  }

  #quit(): void {
    this.#renderer.release();
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
        this.#append("assistant", e.delta);
        return;
      case "thinking_delta":
        this.#thinkingSeen = true;
        this.#append("thinking", e.delta);
        return;
      case "tool_start":
        this.#closeBlock();
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

  /** The message is over: whatever was streaming is final, and goes to the scrollback now. */
  #finishMessage(message: Message): void {
    const usage = message.usage;
    if (usage) {
      this.#tokens.input += usage.input ?? 0;
      this.#tokens.output += usage.output ?? 0;
      this.#tokens.cacheRead += usage.cacheRead ?? 0;
      this.#cost += usage.cost ?? 0;
    }
    this.#closeBlock();
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
    this.#print("tool", toolBlock(tool, this.#toolBlocksFull, this.#viewportCols));
  }

  #refreshPlace(): void {
    void this.#placeOf?.()
      .then((place) => {
        this.#place = place;
        this.render();
      })
      .catch(() => undefined);
  }

  #finishRun(reason: RunResult["reason"], dropped: string[] | undefined): void {
    this.#refreshPlace();
    this.#running = false;
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
    }
    this.render();
  }

  // ---- ordered blocks ----

  /** Adds streamed text to the open block; a different kind of text closes it first. */
  #append(kind: "thinking" | "assistant", delta: string): void {
    if (this.#open !== undefined && this.#open.kind !== kind) this.#closeBlock();
    // Whitespace between two blocks must not open a block of its own.
    if (this.#open === undefined && delta.trim() === "") return;
    const open = (this.#open ??= { kind: kind, text: "", gap: this.#gapFor(kind), inFence: false });
    open.text += delta;
    this.#spill();
  }

  /** Streaming text taller than the region: the stable head moves to the scrollback, in order. */
  #spill(): void {
    const open = this.#open;
    if (open === undefined) return;
    const split = splitStable(open.text, this.#viewportCols, open.inFence);
    if (split === undefined) return;
    const chunk = formatBlock(open.kind, split.commit, open.inFence);
    const gap = open.gap;
    this.#open = { kind: open.kind, text: split.rest, gap: split.gap, inFence: split.restInFence };
    if (chunk !== "") this.#print(open.kind, chunk, gap);
  }

  /** Prints what is left of the open block and forgets it. */
  #closeBlock(): void {
    const open = this.#open;
    if (open === undefined) return;
    this.#open = undefined;
    const text = formatBlock(open.kind, open.text, open.inFence);
    if (text !== "") this.#print(open.kind, text, open.gap);
  }

  /** Does a block of this kind need a blank row above it, given what is already printed? */
  #gapFor(kind: BlockKind): boolean {
    if (!this.#printedAny) return false;
    return !(kind === "tool" && this.#lastKind === "tool");
  }

  /** Sends one finished piece to the scrollback. `gap` defaults to the usual blank row between blocks. */
  #print(kind: BlockKind, text: string, gap = this.#gapFor(kind)): void {
    if (text === "") return;
    // The renderer repaints the region right after the text: it has to know the current state.
    this.#renderer.update(this.#state());
    this.#renderer.printAbove(gap ? `\n${text}` : text);
    this.#printedAny = true;
    this.#lastKind = kind;
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

  #state(): { lines: string[]; row: number; col: number } {
    // "> " in front, the block cursor may sit one column past the text, and the renderer's margin.
    const editorWidth = Math.max(1, (this.#viewportCols ?? 80) - 5);
    const view = this.#editor.view(wrapTo(editorWidth));
    return liveRegion({
      open: this.#open,
      tool: this.#tool,
      toolGap: this.#gapFor("tool"),
      marker: this.#marker,
      queued: this.#queued,
      editorLines: view.lines,
      editorEmpty: this.#editor.empty,
      editorRow: view.row,
      editorCol: view.col,
      status: this.statusLine,
      place: this.#place,
      viewportRows: this.#viewportRows,
      viewportCols: this.#viewportCols,
    });
  }

  // ---- slash commands ----

  /** Runs a slash command. Returns false when the name is unknown. */
  async command(input: string): Promise<boolean> {
    const [name = ""] = input.replace(/^\//, "").split(" ");
    switch (name) {
      case "help":
        this.#print("system", HELP);
        this.render();
        return true;
      case "model":
        this.#print("system", `model: ${this.#model}  context: ${this.#window} tokens`);
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
        this.#print("system", moved);
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
