/* oxlint-disable no-await-in-loop -- the agent loop is linear by design: one provider request at
   a time, tools and log appends in order. Parallelism here would be a bug, not a speed-up. */
import { compactHistory, isContextOverflow, shouldCompact } from "./compact.ts";
import type { Extensions } from "./ext.ts";
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
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
  | { type: "compacted"; keep: number } // head of the history replaced by a summary, tail kept
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "limit"; dropped?: string[] };

export type RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[] };

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

    try {
      const result = await this.#run(text);
      this.#emit({ type: "run_end", reason: result.reason, dropped: result.dropped });
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
      if (this.#turns >= this.#maxTurns) return { reason: "limit" };
      if (this.#cost >= this.#maxCost) return { reason: "limit" };

      this.#turns++;
      // Late trigger, before the request that would otherwise not fit.
      if (this.#contextWindow > 0 && shouldCompact(this.#messages, this.#contextWindow)) await this.#compact();
      if (this.#abortController!.signal.aborted) return this.#handleAbort();

      const req: ProviderRequest = {
        model: this.#model,
        system: this.#system,
        messages: this.#ext ? this.#ext.chain("context", this.#messages) : this.#messages,
        tools: this.#tools,
        signal: this.#abortController!.signal,
      };
      this.#ext?.emit("before_provider_request", req);

      this.#emit({ type: "request_start", at: Date.now() });
      let firstToken = false;
      const streamEvents: StreamEvent[] = [];
      let stopReason: StopReason = "end";
      let usage: Usage | undefined;
      let overflow = false;

      // oxlint-disable-next-line no-await-in-loop -- consume SSE frames sequentially to preserve message/tool-call ordering
      for await (const ev of this.#provider.stream(req)) {
        if (this.#abortController!.signal.aborted) {
          // Awaited: the partial message must reach the log (and the UI) before run_end.
          await this.#emitPartialAssistant(streamEvents);
          return this.#handleAbort();
        }
        streamEvents.push(ev);
        if (!firstToken && (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_call")) {
          firstToken = true;
          this.#emit({ type: "first_token", at: Date.now() });
        }
        if (ev.type === "text") {
          this.#emit({ type: "message_delta", delta: ev.delta });
        } else if (ev.type === "thinking") {
          this.#emit({ type: "thinking_delta", delta: ev.delta });
        } else if (ev.type === "error") {
          if (isContextOverflow(ev.message)) overflow = true;
          else streamEvents.push(ev);
        } else if (ev.type === "done") {
          stopReason = ev.stop ?? "end";
          if (ev.usage) usage = ev.usage;
        }
      }

      if (this.#abortController!.signal.aborted) {
        await this.#emitPartialAssistant(streamEvents);
        return this.#handleAbort();
      }

      // Reactive trigger: the provider rejected the prompt, so shrink and retry the same turn.
      if (overflow && (await this.#compact())) continue;

      const text = joinOf(streamEvents, "text");
      const toolCalls = callsOf(streamEvents);

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        stop: stopReason,
        usage,
      };
      const thinking = joinOf(streamEvents, "thinking");
      if (thinking) assistantMsg.thinking = thinking;
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls;
      await this.#push(assistantMsg);
      this.#ext?.emit("turn_end", assistantMsg);
      this.#emit({ type: "message_end", message: assistantMsg });

      if (toolCalls.length === 0) {
        const steer = this.#steerQueue.shift();
        if (steer !== undefined) {
          this.#notifyQueueChange();
          await this.#push({ id: crypto.randomUUID(), role: "user", content: steer });
          continue;
        }
        const followUp = this.#followUpQueue.shift();
        if (followUp !== undefined) {
          this.#notifyQueueChange();
          await this.#push({ id: crypto.randomUUID(), role: "user", content: followUp });
          continue;
        }
        const finalReason = stopReason === "aborted" ? "aborted" : stopReason === "length" ? "limit" : stopReason === "error" ? "error" : "done";
        return { reason: finalReason };
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
        if (this.#malformedCount >= 3) return { reason: "error" };
      }

      const ro = valid.filter((tc) => this.#tools.find((t) => t.name === tc.name)!.readOnly);
      const rw = valid.filter((tc) => !this.#tools.find((t) => t.name === tc.name)!.readOnly);
      for (const tc of ro) {
        // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
        const msg = await this.#runTool(tc);
        await this.#push(msg);
      }
      for (const tc of rw) {
        // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
        const msg = await this.#runTool(tc);
        await this.#push(msg);
      }

      if (this.#abortController!.signal.aborted) {
        return this.#handleAbort();
      }

      const steerAfter = this.#steerQueue.shift();
      if (steerAfter !== undefined) {
        this.#notifyQueueChange();
        await this.#push({ id: crypto.randomUUID(), role: "user", content: steerAfter });
        continue;
      }
    }
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

function callsOf(events: StreamEvent[]): ToolCall[] {
  return events.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);
}
