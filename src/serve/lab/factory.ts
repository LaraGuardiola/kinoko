// What Kinoko Lab knows about one agent, built from its events: where the run is now, what each
// machine holds, the sentence under the board, and the items each event sends along the belts.
// Pure: no DOM, no clock, no network, so a run can be replayed and tested event by event.

import type { AgentEvent, AppendKind, GuardKind, RequestSize } from "../../agent-events.ts";
import type { Message, ToolCall, Usage } from "../../types.ts";
import type { MachineId } from "./machines.ts";
import { SAY } from "./words.ts";

/** How a tile looks: the run is here (active), it waits for you, it works on its own (busy)… */
export type Tone = "idle" | "active" | "waiting" | "busy" | "warn" | "error" | "done";

/** What rides a belt: coloured by what it is. */
export type ItemKind = "user" | "note" | "history" | "system" | "tools" | "request" | "token" | "reply" | "call" | "result" | "error" | "nudge" | "summary" | "end";

export interface Move {
  route: MachineId[];
  kind: ItemKind;
  label?: string;
  /** Wait this long first (ms at normal speed): what follows another item leaves after it. */
  delay?: number;
}

export interface Entry {
  role: Message["role"];
  kind?: AppendKind | "summary";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
}

export type CallStatus = "gate" | "asking" | "running" | "done" | "failed" | "blocked" | "denied";

export interface CallRecord {
  call: ToolCall;
  status: CallStatus;
  gate?: Extract<AgentEvent, { type: "gate" }>;
  output?: string;
}

const KEEP = 40; // log lines kept per machine

export class Factory {
  running = false;
  cursor: MachineId | undefined;
  caption = SAY.idle;
  model = "";
  history: Entry[] = [];
  /** Requests in the run in progress (or the last one). */
  turn = 0;
  /** The last request's size, and how long the history was when it left (the context filter's input). */
  request: (RequestSize & { model: string; history: number }) | undefined;
  prefill: { done: number; total: number } | undefined;
  usage: Usage | undefined;
  reply = { thinking: "", text: "", pending: [] as string[] };
  calls: CallRecord[] = [];
  /** The request's reply has ended and its calls were handed over (false while it streams). */
  dispatched = false;
  /** The last call that reached the workbench: what it shows once the reply moved on. */
  worked: CallRecord | undefined;
  gates: Array<Extract<AgentEvent, { type: "gate" }>> = [];
  guards: Array<{ what: GuardKind; detail: string; turn: number }> = [];
  approval: { id: string; call: ToolCall; reason: string } | undefined;
  approvals: Array<{ call: ToolCall; reason: string; allow?: boolean; by?: string }> = [];
  queue = { steer: [] as string[], followUp: [] as string[] };
  jobs = 0;
  compaction: { done: number; total?: number } | undefined;
  compactions = 0;
  retry: Extract<AgentEvent, { type: "retry" }> | undefined;
  ended: { reason: string; detail?: string } | undefined;
  totals = { requests: 0, input: 0, output: 0, cached: 0 };
  #prompt = "";
  #waitingReply = -1; // the history entry a reply's message_end fills in
  #waitingText = -1; // the entry a delivered steer or follow-up fills in
  #result: CallRecord | "unknown" | undefined; // what the next result appended answers

  /** The conversation so far (an attach): the floor starts from it, idle. */
  load(messages: Message[]): void {
    this.history = messages.map((m) => ({ role: m.role, content: m.content, ...(m.thinking ? { thinking: m.thinking } : {}), ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}) }));
  }

  /** One event: the floor's new state, and what it sends along the belts. */
  apply(e: AgentEvent): Move[] {
    switch (e.type) {
      case "run_start":
        Object.assign(this, { running: true, turn: 0, ended: undefined, retry: undefined, calls: [], caption: SAY.runStart(e.prompt) });
        this.#prompt = e.prompt;
        this.cursor = "inbox";
        return [];
      case "appended":
        return this.#appended(e);
      case "request_start":
        this.turn++;
        this.totals.requests++;
        this.request = { messages: e.messages, tools: e.tools, chars: e.chars, tokens: e.tokens, model: e.model, history: this.history.length };
        this.model = e.model;
        this.prefill = undefined;
        this.reply = { thinking: "", text: "", pending: [] };
        this.dispatched = false;
        this.cursor = "request";
        this.caption = SAY.request(this.turn, e.tools, e.messages, e.tokens);
        return [
          { route: ["history", "context", "request"], kind: "history", label: `${e.messages}` },
          { route: ["press", "request"], kind: "system" },
          { route: ["toolbox", "request"], kind: "tools", label: `${e.tools}` },
          { route: ["request", "prefill"], kind: "request", delay: 700 },
        ];
      case "prefill":
        this.prefill = { done: e.done, total: e.total };
        this.cursor = "prefill";
        this.caption = SAY.prefill(e.done, e.total);
        return [];
      case "first_token":
        this.cursor = "stream";
        this.caption = SAY.firstToken;
        return [{ route: ["prefill", "stream"], kind: "token" }];
      case "thinking_delta":
        this.reply.thinking += e.delta;
        this.caption = SAY.thinking;
        return [];
      case "message_delta":
        this.reply.text += e.delta;
        this.caption = SAY.writing;
        return [];
      case "tool_pending":
        if (!this.reply.pending.includes(e.name) || e.index !== undefined) this.reply.pending[e.index ?? this.reply.pending.length] = e.name;
        this.caption = SAY.pending(e.name);
        return [];
      case "message_end":
        return this.#messageEnd(e.message);
      case "tool_start":
        this.#call(e.call).status = "gate";
        this.cursor = "gate";
        this.caption = SAY.dispatch(e.call.name);
        return [{ route: ["dispatcher", "gate"], kind: "call", label: e.call.name }];
      case "gate":
        return this.#gate(e);
      case "approval_request":
        this.approval = { id: e.id, call: e.call, reason: e.reason };
        this.cursor = "approval";
        return [];
      case "approval_end":
        return this.#approvalEnd(e);
      case "tool_output": {
        const record = this.#call(e.call);
        const failed = e.output.startsWith("ERROR");
        record.output = e.output;
        this.#result = record;
        if (record.status === "running") record.status = failed ? "failed" : "done";
        else if (record.status === "gate" || record.status === "asking") record.status = e.output === "Aborted by user" ? "denied" : "blocked";
        if (record.status === "done") this.caption = SAY.output(e.call.name, e.output.length);
        if (record.status === "failed") this.caption = SAY.failed(e.call.name, e.output.replace(/^ERROR:\s*/, ""));
        return [];
      }
      case "tool_end":
        return [];
      case "guard":
        if (e.what === "unknown_tool") this.#result = "unknown";
        this.guards = [...this.guards, { what: e.what, detail: e.detail, turn: this.turn }].slice(-KEEP);
        this.cursor = "guards";
        this.caption = SAY.guard(e.detail);
        return [];
      case "queue_change":
        this.queue = { steer: e.steer, followUp: e.followUp };
        if (e.steer.length + e.followUp.length > 0) this.caption = SAY.queued(e.steer.length, e.followUp.length);
        return [];
      case "delivered":
        if (this.#waitingText >= 0 && this.history[this.#waitingText]) this.history[this.#waitingText]!.content = e.text;
        this.#waitingText = -1;
        this.caption = SAY.delivered(e.text);
        return [];
      case "compacting": {
        const first = this.compaction === undefined;
        this.compaction = { done: e.done, ...(e.total !== undefined ? { total: e.total } : {}) };
        this.cursor = "compactor";
        this.caption = SAY.compacting(e.done, e.total);
        return first ? [{ route: ["history", "compactor"], kind: "history" }] : [];
      }
      case "compacted":
        return this.#compacted(e.keep);
      case "retry":
        this.retry = e;
        this.cursor = "request";
        this.caption = SAY.retry(e.attempt, e.of, e.inMs, e.error);
        return [];
      case "jobs": {
        const more = e.running > this.jobs;
        this.jobs = e.running;
        this.caption = SAY.jobs(e.running);
        return more ? [{ route: ["workbench", "jobs"], kind: "call", label: "shell" }] : [];
      }
      case "model":
        this.model = e.model;
        this.caption = SAY.model(e.model);
        return [];
      case "run_end":
        this.running = false;
        this.ended = { reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) };
        this.cursor = "exit";
        this.approval = undefined;
        this.caption = SAY.end(e.reason, e.detail);
        return e.reason === "done" ? [{ route: ["dispatcher", "exit"], kind: "end" }] : [];
    }
    return [];
  }

  #appended(e: Extract<AgentEvent, { type: "appended" }>): Move[] {
    const entry: Entry = { role: e.role, kind: e.kind, content: e.text ?? "" };
    if (e.kind === "prompt") entry.content = this.#prompt;
    if (e.kind === "result") entry.content = this.#result === "unknown" ? "ERROR: unknown tool" : (this.#result?.output ?? "");
    this.history.push(entry);
    const at = this.history.length - 1;
    if (e.kind === "reply") this.#waitingReply = at;
    if (e.kind === "steer" || e.kind === "follow_up") this.#waitingText = at;
    if (e.kind === "note") this.caption = SAY.note(e.text ?? "");
    if (e.kind === "nudge") this.caption = SAY.nudge(e.text ?? "");
    if (this.running && e.kind !== "reply" && e.kind !== "result") this.cursor = "history";
    switch (e.kind) {
      case "prompt":
      case "steer":
      case "follow_up":
        return [{ route: ["inbox", "history"], kind: "user" }];
      case "note":
        return [{ route: ["inbox", "history"], kind: "note" }];
      case "nudge":
        return [{ route: ["guards", "history"], kind: "nudge" }];
      case "reply":
        return [{ route: ["stream", "history"], kind: "reply" }];
      case "result":
        return [this.#resultMove()];
    }
    return [];
  }

  /** A result rides back from where the call stopped: the workbench, the gate, the approval desk. */
  #resultMove(): Move {
    const last = this.#result;
    this.#result = undefined;
    if (last === undefined || last === "unknown") return { route: ["guards", "history"], kind: "error" }; // the call never left
    if (last.status === "blocked") return { route: ["gate", "history"], kind: "error" };
    if (last.status === "denied") return { route: ["approval", "gate", "history"], kind: "error" };
    return { route: ["workbench", "history"], kind: last.status === "failed" ? "error" : "result", label: last.call.name };
  }

  #messageEnd(message: Message): Move[] {
    if (message.role !== "assistant") return [];
    const entry = this.history[this.#waitingReply];
    if (entry !== undefined) Object.assign(entry, { content: message.content, ...(message.thinking ? { thinking: message.thinking } : {}), ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) });
    this.#waitingReply = -1;
    this.reply.text = message.content;
    if (message.thinking) this.reply.thinking = message.thinking;
    if (message.usage) {
      this.usage = message.usage;
      this.totals.input += message.usage.input;
      this.totals.output += message.usage.output;
      this.totals.cached += message.usage.cacheRead ?? 0;
    }
    const calls = message.toolCalls ?? [];
    this.calls = calls.map((call) => ({ call, status: "gate" }));
    this.dispatched = true;
    this.caption = calls.length > 0 ? SAY.replyCalls(calls.map((c) => c.name)) : SAY.replyNoCalls;
    this.cursor = calls.length > 0 ? "dispatcher" : "stream";
    return calls.length > 0 ? [{ route: ["stream", "guards", "dispatcher"], kind: "reply", label: `${calls.length}` }] : [];
  }

  #gate(e: Extract<AgentEvent, { type: "gate" }>): Move[] {
    const record = this.#call(e.call);
    record.gate = e;
    this.gates = [...this.gates, e].slice(-KEEP);
    const name = e.call.name;
    if (e.decision === "block") {
      record.status = "blocked";
      this.caption = SAY.block(name, e.reason ?? "", e.by);
      return [];
    }
    if (e.decision === "ask" && e.skipped === undefined) {
      record.status = "asking";
      this.approvals = [...this.approvals, { call: e.call, reason: e.reason ?? "" }].slice(-KEEP);
      this.cursor = "approval";
      this.caption = SAY.ask(name, e.reason ?? "", e.by);
      return [{ route: ["gate", "approval"], kind: "call", label: name }];
    }
    record.status = "running";
    this.worked = record;
    this.cursor = "workbench";
    this.caption = e.skipped ? SAY.skipped(name, e.skipped) : e.rewritten ? SAY.rewritten(name) : SAY.pass(name, e.by);
    return [{ route: ["gate", "workbench"], kind: "call", label: name }];
  }

  #approvalEnd(e: Extract<AgentEvent, { type: "approval_end" }>): Move[] {
    const asked = this.approval;
    this.approval = undefined;
    const last = this.approvals.at(-1);
    if (last) Object.assign(last, { allow: e.allow, by: e.by });
    const record = asked ? this.#call(asked.call) : undefined;
    if (!e.allow) {
      if (record) record.status = "denied";
      this.caption = SAY.denied(e.by);
      return [];
    }
    if (record) {
      record.status = "running";
      this.worked = record;
    }
    this.cursor = "workbench";
    this.caption = SAY.allowed(e.by);
    return [{ route: ["approval", "workbench"], kind: "call", label: asked?.call.name ?? "" }];
  }

  #compacted(keep: number): Move[] {
    this.compaction = undefined;
    this.caption = SAY.compacted(keep);
    if (keep < 0) return [];
    this.compactions++;
    const kept = keep > 0 ? this.history.slice(-keep) : [];
    this.history = [{ role: "user", kind: "summary", content: "A summary of the older messages (kept in the session log)." }, ...kept];
    this.cursor = "history";
    return [{ route: ["compactor", "history"], kind: "summary" }];
  }

  /** The record of a call of the last reply (one is made for a call it did not list). */
  #call(call: ToolCall): CallRecord {
    let record = this.calls.find((r) => r.call.id === call.id);
    if (record === undefined) {
      record = { call, status: "gate" };
      this.calls.push(record);
    }
    return record;
  }
}
