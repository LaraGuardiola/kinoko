/* oxlint-disable no-await-in-loop -- the agent loop is linear by design: one provider request at
   a time, tools and log appends in order. Parallelism here would be a bug, not a speed-up. */
import { compactHistory, isContextOverflow, shouldCompact } from "./compact.ts";
import type { Extensions } from "./ext.ts";
import { CallGuard, MAX_NUDGES, NUDGE_EMPTY, NUDGE_LENGTH, NUDGE_REPEAT, RepeatGuard, STOP_CALLS, WARN_CALLS, repeatNote, sameErrorNote } from "./guard.ts";
import type { Session } from "./session.ts";
import type {
  Message,
  Provider,
  ProviderRequest,
  StreamEvent,
  Tool,
  ToolCall,
  ToolContext,
  Usage,
  StopReason,
} from "./types.ts";

export type AgentEvent =
  | { type: "run_start"; prompt: string }
  | { type: "request_start"; at: number } // epoch ms: TUI shows "reading prompt..." until first_token
  | { type: "first_token"; at: number } // epoch ms of the first delta of any kind
  | { type: "message_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_pending"; name: string } // the model began writing a call to this tool
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
  | { type: "delivered"; text: string } // a queued steer/follow-up just reached the model
  | { type: "compacted"; keep: number } // head of the history replaced by a summary, tail kept
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

// `detail` says which limit or error stopped the run, for the UI.
export type RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

export class Agent {
  #state: "idle" | "running" = "idle";
  #messages: Message[] = [];
  #listeners: Set<(e: AgentEvent) => void> = new Set();
  #provider: Provider;
  #model: string;
  #system: string;
  #tools: Tool[];
  #maxTurns: number;
  #maxCost: number;
  #turns = 0;
  #cost = 0;
  #abortController: AbortController | null = null;
  #steerQueue: string[] = [];
  #followUpQueue: string[] = [];
  #malformedCount = 0;
  #nudges = 0; // cut-off or looping replies in a row, each answered with a nudge
  #calls = new CallGuard();
  #session: Session | undefined;
  #contextWindow = 0;
  #ext: Extensions | undefined;

  constructor(opts: {
    provider: Provider;
    model: string;
    system: string;
    tools: Tool[];
    maxTurns: number;
    maxCost: number;
    session?: Session; // when given, the session log owns the history and every message is appended
    contextWindow?: number; // 0 disables compaction
    extensions?: Extensions;
  }) {
    this.#provider = opts.provider;
    this.#model = opts.model;
    this.#system = opts.system;
    this.#tools = opts.tools;
    this.#maxTurns = opts.maxTurns;
    this.#maxCost = opts.maxCost;
    this.#session = opts.session;
    this.#contextWindow = opts.contextWindow ?? 0;
    this.#ext = opts.extensions;
    if (this.#session) this.#messages = [...this.#session.view()];
  }

  get state(): "idle" | "running" {
    return this.#state;
  }

  get messages(): Message[] {
    return [...this.#messages];
  }

  on(listener: (e: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: AgentEvent): void {
    for (const l of this.#listeners) l(e);
  }

  #notifyQueueChange(): void {
    this.#emit({ type: "queue_change", steer: [...this.#steerQueue], followUp: [...this.#followUpQueue] });
  }

  abort(): void {
    if (this.#state !== "running") return;
    this.#abortController?.abort();
  }

  steer(text: string): void {
    if (!text.trim()) return;
    this.#steerQueue.push(text);
    this.#notifyQueueChange();
  }

  followUp(text: string): void {
    if (!text.trim()) return;
    this.#followUpQueue.push(text);
    this.#notifyQueueChange();
  }

  async prompt(text: string): Promise<RunResult> {
    if (this.#state === "running") {
      throw new Error("Agent already running");
    }
    this.#state = "running";
    this.#abortController = new AbortController();
    this.#turns = 0;
    this.#cost = 0;
    this.#malformedCount = 0;
    this.#nudges = 0;
    this.#calls = new CallGuard();

    try {
      const result = await this.#run(text);
      this.#emit({ type: "run_end", reason: result.reason, dropped: result.dropped, detail: result.detail });
      this.#ext?.emit("run_end", result);
      return result;
    } finally {
      this.#state = "idle";
      this.#abortController = null;
    }
  }

  async #run(initialPrompt: string): Promise<RunResult> {
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: initialPrompt };
    await this.#push(userMsg);
    this.#emit({ type: "run_start", prompt: initialPrompt });

    while (true) {
      if (this.#abortController!.signal.aborted) {
        return this.#handleAbort();
      }
      if (this.#turns >= this.#maxTurns) return { reason: "limit", detail: `turn limit (${this.#maxTurns})` };
      if (this.#cost >= this.#maxCost) return { reason: "limit", detail: `cost limit ($${this.#maxCost})` };

      this.#turns++;
      // Late trigger, before the request that would otherwise not fit.
      if (this.#contextWindow > 0 && shouldCompact(this.#messages, this.#contextWindow)) await this.#compact();
      if (this.#abortController!.signal.aborted) return this.#handleAbort();

      // The turn's own signal lets a loop guard cut this one reply without aborting the run.
      const turn = new AbortController();
      const req: ProviderRequest = {
        model: this.#model,
        system: this.#system,
        messages: this.#ext ? this.#ext.chain("context", this.#messages) : this.#messages,
        tools: this.#tools,
        signal: AbortSignal.any([this.#abortController!.signal, turn.signal]),
      };
      this.#ext?.emit("before_provider_request", req);

      this.#emit({ type: "request_start", at: Date.now() });
      let firstToken = false;
      const streamEvents: StreamEvent[] = [];
      let stopReason: StopReason = "end";
      let usage: Usage | undefined;
      let overflow = false;
      let looping = false;
      const guards = { text: new RepeatGuard(), thinking: new RepeatGuard() };

      // oxlint-disable-next-line no-await-in-loop -- consume SSE frames sequentially to preserve message/tool-call ordering
      for await (const ev of this.#provider.stream(req)) {
        if (this.#abortController!.signal.aborted) {
          // Awaited: the partial message must reach the log (and the UI) before run_end.
          await this.#emitPartialAssistant(streamEvents);
          return this.#handleAbort();
        }
        streamEvents.push(ev);
        if (!firstToken && (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_pending" || ev.type === "tool_call")) {
          firstToken = true;
          this.#emit({ type: "first_token", at: Date.now() });
        }
        if (ev.type === "text" || ev.type === "thinking") {
          this.#emit({ type: ev.type === "text" ? "message_delta" : "thinking_delta", delta: ev.delta });
          if (guards[ev.type].push(ev.delta)) {
            looping = true;
            turn.abort();
            break;
          }
        } else if (ev.type === "tool_pending") {
          this.#emit({ type: "tool_pending", name: ev.name });
        } else if (ev.type === "error") {
          if (isContextOverflow(ev.message)) overflow = true;
          else streamEvents.push(ev);
        } else if (ev.type === "done") {
          stopReason = ev.stop ?? "end";
          if (ev.usage) usage = ev.usage;
          this.#cost += ev.usage?.cost ?? 0;
        }
      }

      if (this.#abortController!.signal.aborted) {
        await this.#emitPartialAssistant(streamEvents);
        return this.#handleAbort();
      }

      // Reactive trigger: the provider rejected the prompt, so shrink and retry the same turn.
      if (overflow && (await this.#compact())) continue;

      const text = joinOf(streamEvents, "text");
      // A reply cut by a loop guard keeps neither its looping thinking nor its unfinished calls.
      const toolCalls = looping ? [] : callsOf(streamEvents);

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        stop: looping ? "length" : stopReason,
        usage,
      };
      const thinking = joinOf(streamEvents, "thinking");
      if (thinking && !looping) assistantMsg.thinking = thinking;
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls;
      const replay = streamEvents.findLast((e) => e.type === "replay");
      if (replay?.type === "replay") assistantMsg.replay = replay.data;
      await this.#push(assistantMsg);
      this.#ext?.emit("turn_end", assistantMsg);
      this.#emit({ type: "message_end", message: assistantMsg });

      if (toolCalls.length > 0) this.#nudges = 0;
      if (toolCalls.length === 0) {
        const steer = this.#steerQueue.shift();
        if (steer !== undefined) {
          await this.#deliver(steer);
          continue;
        }
        // Cut off (output limit), looping, or empty (nothing said, nothing called): the work is not
        // done, so nudge instead of stopping.
        const empty = stopReason === "end" && text.trim() === "";
        if (looping || stopReason === "length" || empty) {
          const [nudge, why] = looping
            ? [NUDGE_REPEAT, "the model keeps repeating itself"]
            : empty
              ? [NUDGE_EMPTY, "the model keeps replying with nothing"]
              : [NUDGE_LENGTH, "output token limit (maxOutputTokens)"];
          if (this.#nudges >= MAX_NUDGES) return { reason: "limit", detail: why };
          this.#nudges++;
          await this.#push({ id: crypto.randomUUID(), role: "user", content: nudge });
          continue;
        }
        const followUp = this.#followUpQueue.shift();
        if (followUp !== undefined) {
          await this.#deliver(followUp);
          continue;
        }
        const finalReason = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "done";
        return finalReason === "error" ? { reason: "error", detail: errorOf(streamEvents) } : { reason: finalReason };
      }

      const valid = toolCalls.filter((tc) => this.#tools.some((t) => t.name === tc.name));
      const invalid = toolCalls.filter((tc) => !this.#tools.some((t) => t.name === tc.name));

      for (const tc of invalid) {
        this.#malformedCount++;
        await this.#push({
          id: crypto.randomUUID(),
          role: "tool",
          content: `ERROR: unknown tool ${tc.name}`,
          toolCallId: tc.id,
        });
        if (this.#malformedCount >= 3) return { reason: "error", detail: "unknown tool calls" };
      }

      // In the order the model wrote them: [write a, read a] must read the new a.
      let stuck = 0;
      for (const tc of valid) {
        // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
        const msg = await this.#runTool(tc);
        const repeats = this.#calls.record(tc, msg.content);
        const failures = this.#calls.failures(tc, msg.content);
        if (repeats >= WARN_CALLS) msg.content += repeatNote(repeats, !this.#tools.find((t) => t.name === tc.name)?.readOnly);
        else if (failures >= WARN_CALLS) msg.content += sameErrorNote(failures);
        stuck = Math.max(stuck, repeats);
        await this.#push(msg);
      }

      if (this.#abortController!.signal.aborted) {
        return this.#handleAbort();
      }
      if (stuck >= STOP_CALLS) return { reason: "limit", detail: `stuck: the same call returned the same result ${stuck} times` };

      const steerAfter = this.#steerQueue.shift();
      if (steerAfter !== undefined) {
        await this.#deliver(steerAfter);
        continue;
      }
    }
  }

  /** A queued message leaves the queue and becomes the next user message, in that order. */
  async #deliver(text: string): Promise<void> {
    this.#notifyQueueChange();
    await this.#push({ id: crypto.randomUUID(), role: "user", content: text });
    this.#emit({ type: "delivered", text: text });
  }

  /** Appends to the in-memory history and, when a session is open, to the append-only log. */
  async #push(message: Message): Promise<Message> {
    const stored = this.#session ? await this.#session.append(message) : message;
    this.#messages.push(stored);
    return stored;
  }

  /**
   * Compacts outside a run, for /compact. Uses its own signal so nothing the user is typing gets
   * cut short, and restores the run's controller afterwards.
   */
  async compactNow(): Promise<boolean> {
    const running = this.#abortController;
    this.#abortController = new AbortController();
    try {
      return await this.#compact();
    } finally {
      this.#abortController = running;
    }
  }

  /** Replaces the head of the history with a summary. Returns false when nothing changed. */
  async #compact(): Promise<boolean> {
    const result = await compactHistory(this.#messages, {
      provider: this.#provider,
      model: this.#model,
      system: this.#system,
      signal: this.#abortController!.signal,
    });
    if (!result) return false;
    if (this.#session) result.summary = await this.#session.markCompaction(result.summary, result.keepFrom);
    const before = this.#messages.length;
    this.#messages = result.view;
    this.#ext?.emit("compact", { before: before, after: this.#messages.length });
    this.#emit({ type: "compacted", keep: result.view.length - 1 });
    return true;
  }

  async #runTool(tc: ToolCall): Promise<Message> {
    const tool = this.#tools.find((t) => t.name === tc.name)!;
    this.#emit({ type: "tool_start", call: tc });
    const signal = this.#abortController!.signal;
    const ctx: ToolContext = { signal: signal, cwd: process.cwd() };

    // Extensions get the last word: they may rewrite args, or block the call outright.
    if (this.#ext) {
      const event = { name: tc.name, args: tc.args as Record<string, unknown>, signal: signal };
      const blocked = this.#ext.beforeTool(event);
      if (blocked) {
        this.#emit({ type: "tool_output", call: tc, output: blocked.reason });
        this.#emit({ type: "tool_end", call: tc });
        return { id: crypto.randomUUID(), role: "tool", content: blocked.reason, toolCallId: tc.id };
      }
    }

    try {
      if (signal.aborted) {
        throw new Error("Aborted by user");
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
      const output = await tool.run(tc.args, ctx);
      if (signal.aborted) {
        throw new Error("Aborted by user");
      }
      const result = { name: tc.name, output: output, signal: signal };
      this.#ext?.emit("tool_result", result);
      this.#emit({ type: "tool_output", call: tc, output: result.output });
      this.#emit({ type: "tool_end", call: tc });
      return { id: crypto.randomUUID(), role: "tool", content: result.output, toolCallId: tc.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAborted = msg === "Aborted by user" || this.#abortController!.signal.aborted;
      this.#emit({ type: "tool_output", call: tc, output: isAborted ? "Aborted by user" : `ERROR: ${msg}` });
      this.#emit({ type: "tool_end", call: tc });
      return { id: crypto.randomUUID(), role: "tool", content: isAborted ? "Aborted by user" : `ERROR: ${msg}`, toolCallId: tc.id };
    }
  }

  async #emitPartialAssistant(streamEvents: StreamEvent[]): Promise<void> {
    const text = joinOf(streamEvents, "text");
    const thinking = joinOf(streamEvents, "thinking");
    const calls = callsOf(streamEvents);
    if (!text && !thinking) return;
    const msg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      stop: "aborted",
    };
    if (thinking) msg.thinking = thinking;
    if (calls.length > 0) msg.toolCalls = calls;
    await this.#push(msg);
    this.#emit({ type: "message_end", message: msg });
  }

  #handleAbort(): RunResult {
    const dropped = [...this.#steerQueue, ...this.#followUpQueue];
    this.#steerQueue = [];
    this.#followUpQueue = [];
    this.#notifyQueueChange();
    return { reason: "aborted", dropped: dropped.length ? dropped : undefined };
  }
}

function joinOf(events: StreamEvent[], kind: "text" | "thinking"): string {
  let out = "";
  for (const e of events) {
    if (e.type === kind) out += (e as { delta: string }).delta;
  }
  return out;
}

function errorOf(events: StreamEvent[]): string | undefined {
  const err = events.findLast((e) => e.type === "error");
  return err?.type === "error" ? err.message.slice(0, 200) : undefined;
}

function callsOf(events: StreamEvent[]): ToolCall[] {
  return events.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);
}
