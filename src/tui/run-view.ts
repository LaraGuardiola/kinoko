// What a run shows while it goes, built from the agent's events: the reply streaming into the
// scrollback, a row for each tool call (written, waiting, running), the messages queued for the
// model, a call waiting for the user's answer, a compaction on its way, the tokens and the cost;
// and, when the run ends, why it ended.

import type { CompactProgress } from "../compact.ts";
import type { AgentEvent, RunResult } from "../agent-events.ts";
import type { Message } from "../types.ts";
import { answeredNote } from "./approval.ts";
import type { ApprovalView } from "./approval.ts";
import type { Marker } from "./marker.ts";
import type { Scrollback } from "./scrollback.ts";
import type { SidePanel } from "./side.ts";
import { TODO_TOOL } from "./todos.ts";
import { errorBlock, pulseLevel, toolBlock, toolFailed, toolSummary } from "./tools.ts";
import { ABORTED, formatBlock } from "./view.ts";
import type { QueuedView, ToolLine, ToolView } from "./view.ts";

export interface Tokens {
  /** How full the context is now: the last request's input and output. */
  context: number;
  /** The session's totals: sent, read from the engine's cache, generated. */
  input: number;
  cacheRead: number;
  output: number;
}

export interface RunViewOptions {
  scrollback: Scrollback;
  marker: Marker;
  side: SidePanel;
  /** The window's columns: the side panel only refreshes while it is on screen. */
  columns: () => number | undefined;
  /** The transcript's columns, and whether the side column (with the plan) is on. */
  printColumns: () => number | undefined;
  sideOn: () => boolean;
  /** Messages the user had queued, back into the editor when the run was cut before they went. */
  giveBack: (text: string) => void;
  /** The line under the editor (cwd and branch): a tool may have changed it. */
  refreshPlace: () => void;
  render: () => void;
}

export class RunView {
  #opts: RunViewOptions;
  #running = false;
  #thinkingSeen = false; // this message already streamed its thinking
  #tool: ToolView | undefined; // the call running now
  // The reply's calls not started yet, in order: written so far while it streams, then all of them.
  #calls: Array<{ id?: string; index?: number; name: string; args: string }> = [];
  #written = false; // the reply is over: #calls holds all of its calls, the first one next
  #queued: QueuedView[] = [];
  #approval: ApprovalView | undefined; // a call waiting for the user's answer
  #fullTools = false; // Ctrl+T: tool blocks printed whole
  #compacting: CompactProgress | undefined; // a summary on its way: the note animates
  #retrying = false; // the marker says a retry is coming: the next reply's first token clears it
  #tokens: Tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
  #cost = 0;

  constructor(opts: RunViewOptions) {
    this.#opts = opts;
  }

  get running(): boolean {
    return this.#running;
  }

  get approval(): ApprovalView | undefined {
    return this.#approval;
  }

  get queued(): QueuedView[] {
    return this.#queued;
  }

  get compacting(): CompactProgress | undefined {
    return this.#compacting;
  }

  get tokens(): Tokens {
    return this.#tokens;
  }

  get cost(): number {
    return this.#cost;
  }

  /** The user sent a prompt: the run is on from now, before the agent says so. */
  started(): void {
    this.#running = true;
  }

  /** The prompt's run is over (whatever its end). */
  stopped(): void {
    this.#running = false;
  }

  /** Ctrl+T: tool blocks printed whole, or folded. */
  toggleFullTools(): void {
    this.#fullTools = !this.#fullTools;
  }

  /** A new or resumed session: nothing counted, nothing queued. */
  reset(): void {
    this.#tokens = { context: 0, input: 0, cacheRead: 0, output: 0 };
    this.#cost = 0;
    this.#queued = [];
  }

  /** A resumed conversation: how full its context was, and its totals so far. */
  count(messages: Message[]): void {
    const usage = messages.findLast((m) => m.usage !== undefined)?.usage;
    if (usage) this.#tokens.context = usage.input + usage.output;
    for (const m of messages) {
      this.#tokens.input += m.usage?.input ?? 0;
      this.#tokens.cacheRead += m.usage?.cacheRead ?? 0;
      this.#tokens.output += m.usage?.output ?? 0;
    }
  }

  /** One row per call: the running one first, then those waiting. While the reply streams the
   *  newest is live; once it is over, the next to run. */
  toolLines(): ToolLine[] {
    const running = this.#tool ? [{ name: this.#tool.name, args: this.#tool.args, live: true }] : [];
    const last = this.#calls.length - 1;
    return [...running, ...this.#calls.map((c, i) => ({ name: c.name, args: c.args, live: !this.#tool && i === (this.#written ? 0 : last) }))];
  }

  /** How lit the live call's bullet is now (it fades in and out until the result), if one is live. */
  pulse(): number | undefined {
    return this.#tool || this.#calls.length > 0 ? pulseLevel(Date.now()) : undefined;
  }

  /** What the user (or kinoko, or the phone) said to the model, into the transcript in its place. */
  echoUser(text: string): void {
    const scrollback = this.#opts.scrollback;
    // Closing first keeps the order true: what was already streamed stays above the message.
    scrollback.closeBlock();
    // kinoko's own words to the model (a background job ended) are not the user's.
    const note = `⚙ ${text.slice(9).split("\n")[0]}`;
    if (text.startsWith("[kinoko] ")) scrollback.print("system", formatBlock("system", note, scrollback.width), undefined, undefined, (w) => formatBlock("system", note, w));
    else scrollback.print("user", formatBlock("user", text));
    this.#opts.render();
  }

  onEvent(e: AgentEvent): void {
    const { scrollback, marker, render } = this.#opts;
    switch (e.type) {
      case "run_start":
        // A run this terminal did not start: a prompt from the phone, through kinoko serve.
        if (!this.#running) {
          this.#running = true;
          marker.clear();
          this.echoUser(e.prompt);
        }
        return;
      case "message_delta":
        scrollback.append("assistant", e.delta);
        return;
      case "thinking_delta":
        this.#thinkingSeen = true;
        scrollback.append("thinking", e.delta);
        return;
      case "request_start":
        // A request starts afresh: calls left from the last reply (an unknown tool's) are gone.
        this.#calls = [];
        this.#written = false;
        return;
      case "tool_pending": {
        // The text before the call is final; the call itself shows at once, its bullet pulsing.
        scrollback.closeBlock();
        // Its name first, then what it acts on as soon as that arg is complete (a write's path).
        // Each call of the reply has its own row: a new index is a new call.
        const args = e.args ? toolSummary(e.name, e.args, false) : "";
        const same = this.#calls.find((c) => c.index === e.index);
        if (same) Object.assign(same, { name: e.name }, args === "" ? {} : { args });
        else this.#calls.push({ index: e.index, name: e.name, args });
        render();
        return;
      }
      case "tool_start": {
        scrollback.closeBlock();
        const at = this.#calls.findIndex((c) => c.id === e.call.id);
        this.#calls.splice(at < 0 ? 0 : at, 1);
        this.#opts.side.toolCall(e.call);
        this.#tool = { name: e.call.name, args: toolSummary(e.call.name, e.call.args), output: "", aborted: false };
        render();
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
        // A tool may have run `git init` or switched branch: show it now, not when the run ends;
        // and may have changed files: the side panel's changes too, while it is on screen.
        this.#opts.refreshPlace();
        this.#refreshSide();
        return;
      case "message_end":
        this.#finishMessage(e.message);
        return;
      case "queue_change":
        this.#queued = [...e.steer.map((text) => ({ kind: "steer" as const, text })), ...e.followUp.map((text) => ({ kind: "followUp" as const, text }))];
        render();
        return;
      case "delivered":
        this.echoUser(e.text);
        return;
      case "compacting":
        this.#compacting = { phase: e.phase, done: e.done, total: e.total ?? this.#compacting?.total };
        render();
        return;
      case "compacted":
        this.#compacting = undefined;
        if (e.keep >= 0) marker.inform(`compacted · ${e.keep} message${e.keep === 1 ? "" : "s"} kept as they were`);
        render();
        return;
      case "retry":
        // What streamed before the failure stays on screen; the model starts that reply over.
        scrollback.closeBlock();
        this.#calls = [];
        this.#thinkingSeen = false;
        marker.warn(`${e.error} · retry ${e.attempt}/${e.of} in ${Math.round(e.inMs / 1000)}s`);
        this.#retrying = true;
        render();
        return;
      case "first_token":
        if (this.#retrying) marker.clear();
        this.#retrying = false;
        return;
      case "approval_request":
        this.#approval = { id: e.id, call: e.call, reason: e.reason };
        render();
        return;
      case "approval_end": {
        if (this.#approval?.id === e.id) this.#approval = undefined;
        const note = answeredNote(e.allow, e.by);
        if (note !== "") marker.inform(note);
        render();
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
    this.#opts.scrollback.closeBlock();
    // The calls as written, each on its row until it runs; one cut off before its args were
    // complete never starts, so its pulsing line goes.
    if (message.role === "assistant") {
      this.#written = true;
      this.#calls = (message.toolCalls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: toolSummary(tc.name, tc.args) }));
    }
    // A provider that only reports the reasoning at the end (no deltas): better late than lost.
    const thinking = message.thinking ?? "";
    if (!this.#thinkingSeen && thinking.trim() !== "") this.#opts.scrollback.print("thinking", formatBlock("thinking", thinking));
    this.#thinkingSeen = false;
    this.#opts.render();
  }

  /** The call that ran, into the scrollback as its block. */
  #printTool(): void {
    const tool = this.#tool;
    if (!tool) return;
    const scrollback = this.#opts.scrollback;
    scrollback.closeBlock();
    this.#tool = undefined;
    // With the side column on, the plan is there: its todo calls need no block in the transcript.
    if (tool.name === TODO_TOOL && !tool.aborted && !toolFailed(tool.output) && this.#opts.sideOn()) return;
    const full = this.#fullTools;
    scrollback.print("tool", toolBlock(tool, full, this.#opts.printColumns()), undefined, undefined, (w) => toolBlock(tool, full, w + 2));
  }

  #finishRun(reason: RunResult["reason"], dropped: string[] | undefined, detail?: string): void {
    const { scrollback, marker } = this.#opts;
    this.#opts.refreshPlace();
    this.#refreshSide();
    this.#running = false;
    this.#calls = [];
    this.#queued = [];
    scrollback.closeBlock();
    this.#thinkingSeen = false;
    if (dropped !== undefined && dropped.length > 0) {
      // Nothing the user typed is ever lost: it goes back into the editor.
      this.#opts.giveBack(dropped.join("\n"));
      marker.alert("Interrupted — your queued messages are back in the editor");
    } else if (reason === "aborted") {
      marker.alert("Interrupted");
    } else if (reason === "error") {
      // A failed run says why where it happened, on a band like a failed tool's; the marker points at it.
      const why = detail ?? "unknown error";
      scrollback.print("tool", errorBlock(why, scrollback.width), undefined, undefined, (w) => errorBlock(why, w));
      marker.warn("Stopped — error");
    } else if (reason === "limit") {
      // A run that stops on its own must say why, or it looks like the model gave up.
      marker.warn(`Stopped — ${detail ?? reason}`);
    }
    this.#opts.render();
  }

  #refreshSide(): void {
    const side = this.#opts.side;
    if (side.visible(this.#opts.columns())) side.refresh();
  }
}
