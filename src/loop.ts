/* oxlint-disable no-await-in-loop -- the agent loop is linear by design: one provider request at
   a time, tools and log appends in order. Parallelism here would be a bug, not a speed-up. */
import { Approvals } from "./approvals.ts";
import type { ApprovalBy } from "./approvals.ts";
import { compactHistory, isContextOverflow, shouldCompact } from "./compact.ts";
import type { Extensions } from "./ext.ts";
import { CallGuard, MAX_NUDGES, NUDGE_EMPTY, NUDGE_LENGTH, NUDGE_REPEAT, RepeatGuard, STOP_CALLS, WARN_CALLS, repeatNote, sameErrorNote } from "./guard.ts";
import type { Session } from "./session.ts";
import type {
  Image,
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
  | { type: "tool_pending"; name: string; args?: Record<string, string> } // a call being written, args so far
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
  | { type: "delivered"; text: string } // a queued steer/follow-up just reached the model
  | { type: "compacting"; phase: "reading" | "writing"; done: number; total?: number } // a summary on its way
  | { type: "compacted"; keep: number } // head of the history replaced by a summary, tail kept
  | { type: "approval_request"; id: string; call: ToolCall; reason: string } // an extension asks the user first
  | { type: "approval_end"; id: string; allow: boolean; by: ApprovalBy } // answered (the first answer wins)
  | { type: "retry"; attempt: number; of: number; inMs: number; error: string } // a transient failure: the same request again
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

// `detail` says which limit or error stopped the run, for the UI.
export type RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

export class Agent {
  #state: "idle" | "running" = "idle";
  #messages: Message[] = [];
  #listeners: Set<(e: AgentEvent) => void> = new Set();
  #provider: Provider;
  #model: string;
  #system: (model: string) => string;
  #tools: Tool[];
  #maxTurns: number;
  #maxCost: number;
  #turns = 0;
  #cost = 0;
  #abortController: AbortController | null = null;
  #steerQueue: Queued[] = [];
  /** The reply being streamed: `sendNow` cuts it (and only it) to deliver a steer at once. */
  #turn: AbortController | undefined;
  #cutForSteer = false;
  #queued = 0; // orders the two queues, for taking back the newest
  #followUpQueue: Queued[] = [];
  #malformedCount = 0;
  #nudges = 0; // cut-off or looping replies in a row, each answered with a nudge
  #retries: number;
  #notes: string[] = []; // told to the model before the next user message (a skill installed)
  #retryMs: number;
  #calls = new CallGuard();
  #session: Session | undefined;
  #contextWindow = 0;
  #ext: Extensions | undefined;
  // Set at runtime (the TUI's thinking menu); undefined keeps the provider's configured value.
  #effort: ProviderRequest["effort"];
  #budget: number | undefined;
  #approvals: Approvals;

  constructor(opts: {
    provider: Provider;
    model: string;
    /** The system prompt, or one per model (it names the model, and the model can change). */
    system: string | ((model: string) => string);
    tools: Tool[];
    maxTurns: number;
    maxCost: number;
    session?: Session; // when given, the session log owns the history and every message is appended
    contextWindow?: number; // 0 disables compaction
    extensions?: Extensions;
    retries?: number; // a transient provider failure is retried this many times in a row (default 3)
    retryMs?: number; // the first wait; each next one doubles (default 2s: 2s, 4s, 8s)
    approvalTimeoutMs?: number; // an unanswered approval is a deny after this (default 10 min; 0: deny at once)
  }) {
    this.#provider = opts.provider;
    this.#model = opts.model;
    const system = opts.system;
    this.#system = typeof system === "string" ? () => system : system;
    this.#tools = opts.tools;
    this.#maxTurns = opts.maxTurns;
    this.#maxCost = opts.maxCost;
    this.#session = opts.session;
    this.#contextWindow = opts.contextWindow ?? 0;
    this.#ext = opts.extensions;
    this.#retries = opts.retries ?? 3;
    this.#retryMs = opts.retryMs ?? 2000;
    this.#approvals = new Approvals(opts.approvalTimeoutMs ?? 600_000);
    if (this.#session) this.#messages = [...this.#session.view()];
  }

  get state(): "idle" | "running" {
    return this.#state;
  }

  get messages(): Message[] {
    return [...this.#messages];
  }

  get model(): string {
    return this.#model;
  }

  /** A new conversation (/new): the history is the given session's (empty when it is new), the
   *  queues and pending notes go. Only while idle. */
  restart(session?: Session): void {
    if (this.#state === "running") throw new Error("Agent is running");
    this.#session = session;
    this.#messages = session ? [...session.view()] : [];
    this.#steerQueue = [];
    this.#followUpQueue = [];
    this.#notes = [];
    this.#approvals.forget();
  }

  /** The tools from the next request on (an extension loaded or unloaded while kinoko runs). */
  setTools(tools: Tool[]): void {
    this.#tools = tools;
  }

  /**
   * Something the model should know, said as a `[kinoko]` note right before the next user message:
   * the end of the history is the one place a change costs a local engine nothing (the system
   * prompt stays byte-stable, and so does its cache).
   */
  note(text: string): void {
    this.#notes.push(text);
  }

  /** The next request uses `model` (a run in progress keeps going with it from its next request). */
  setModel(model: string): void {
    this.#model = model;
  }

  /** The context window of the model in use (compaction triggers against it). */
  setContextWindow(contextWindow: number): void {
    this.#contextWindow = contextWindow;
  }

  /** Another endpoint from the next request on (a model added from the TUI); its window too. */
  setProvider(provider: Provider, contextWindow?: number): void {
    this.#provider = provider;
    if (contextWindow !== undefined) this.#contextWindow = contextWindow;
  }

  /** Thinking for the next requests: effort and a token budget (0 = no cap, undefined = configured). */
  setThinking(effort: ProviderRequest["effort"], budget: number | undefined): void {
    this.#effort = effort;
    this.#budget = budget;
  }

  /** What the provider can serve, when it can say: an empty list otherwise. */
  async models(signal: AbortSignal): Promise<string[]> {
    return (await this.#provider.models?.(signal)) ?? [];
  }

  on(listener: (e: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: AgentEvent): void {
    for (const l of this.#listeners) l(e);
  }

  #notifyQueueChange(): void {
    this.#emit({ type: "queue_change", steer: this.#steerQueue.map((q) => q.text), followUp: this.#followUpQueue.map((q) => q.text) });
  }

  abort(): void {
    if (this.#state !== "running") return;
    this.#abortController?.abort();
  }

  /** Answers an approval request (`by` says who: the TUI, the phone, Telegram); false when it is not
   *  waiting any more (another client answered first). `remember` allows the same call for the session. */
  approve(id: string, allow: boolean, opts: { by?: ApprovalBy; remember?: boolean } = {}): boolean {
    return this.#approvals.answer(id, { allow, by: opts.by ?? "tui", remember: opts.remember });
  }

  steer(text: string, images?: Image[]): void {
    if (!text.trim()) return;
    this.#steerQueue.push({ text: text, images: images, seq: ++this.#queued });
    this.#notifyQueueChange();
  }

  followUp(text: string, images?: Image[]): void {
    if (!text.trim()) return;
    this.#followUpQueue.push({ text: text, images: images, seq: ++this.#queued });
    this.#notifyQueueChange();
  }

  /**
   * Delivers the queued steer now: the reply being streamed is cut (its text and thinking so far
   * are kept, unfinished tool calls are not) and the steer becomes the next message. False when
   * there is no steer, or no reply streaming (a steer during tools goes right after them anyway).
   */
  sendNow(): boolean {
    if (this.#state !== "running" || this.#steerQueue.length === 0 || this.#turn === undefined) return false;
    this.#cutForSteer = true;
    this.#turn.abort();
    return true;
  }

  /** Takes queued messages back (the newest, or all), so they are never delivered; their texts in order. */
  unqueue(which: "last" | "all"): string[] {
    const all = [...this.#steerQueue, ...this.#followUpQueue].toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const taken = which === "all" ? all : all.slice(-1);
    if (taken.length === 0) return [];
    this.#steerQueue = this.#steerQueue.filter((q) => !taken.includes(q));
    this.#followUpQueue = this.#followUpQueue.filter((q) => !taken.includes(q));
    this.#notifyQueueChange();
    return taken.map((q) => q.text);
  }

  async prompt(text: string, images?: Image[]): Promise<RunResult> {
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
      const result = await this.#run({ text: text, images: images });
      this.#emit({ type: "run_end", reason: result.reason, dropped: result.dropped, detail: result.detail });
      this.#ext?.emit("run_end", result);
      return result;
    } finally {
      this.#state = "idle";
      this.#abortController = null;
    }
  }

  async #run(initial: Queued): Promise<RunResult> {
    if (this.#notes.length > 0) {
      const notes = this.#notes.splice(0).map((n) => `[kinoko] ${n}`);
      await this.#push({ id: crypto.randomUUID(), role: "user", content: notes.join("\n") });
    }
    await this.#push(userMessage(initial));
    this.#emit({ type: "run_start", prompt: initial.text });

    let retries = 0; // transient failures in a row
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
      this.#turn = turn;
      const req: ProviderRequest = {
        model: this.#model,
        system: this.#system(this.#model),
        messages: this.#ext ? this.#ext.chain("context", this.#messages) : this.#messages,
        tools: this.#tools,
        signal: AbortSignal.any([this.#abortController!.signal, turn.signal]),
        effort: this.#effort,
        budget: this.#budget,
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
          this.#emit({ type: "tool_pending", name: ev.name, args: ev.args });
        } else if (ev.type === "error") {
          if (isContextOverflow(ev.message)) overflow = true;
          else streamEvents.push(ev);
        } else if (ev.type === "done") {
          stopReason = ev.stop ?? "end";
          if (ev.usage) usage = ev.usage;
          this.#cost += ev.usage?.cost ?? 0;
        }
      }

      this.#turn = undefined;
      if (this.#abortController!.signal.aborted) {
        await this.#emitPartialAssistant(streamEvents);
        return this.#handleAbort();
      }
      const cut = this.#cutForSteer;
      this.#cutForSteer = false;

      // Reactive trigger: the provider rejected the prompt, so shrink and retry the same turn.
      if (overflow && (await this.#compact())) continue;

      // A dropped connection or an overloaded server: the same request again after a wait, the
      // partial reply thrown away (its calls are incomplete). Retries cost no turn.
      const failed = stopReason === "error" ? streamEvents.findLast((e) => e.type === "error") : undefined;
      if (failed?.type === "error" && failed.retry && retries < this.#retries) {
        retries++;
        this.#turns--;
        const inMs = this.#retryMs * 2 ** (retries - 1);
        this.#emit({ type: "retry", attempt: retries, of: this.#retries, inMs, error: failed.message.slice(0, 200) });
        if (!(await wait(inMs, this.#abortController!.signal))) return this.#handleAbort();
        continue;
      }
      retries = 0;

      const text = joinOf(streamEvents, "text");
      // A reply cut by a loop guard keeps neither its looping thinking nor its unfinished calls; one
      // cut for a steer keeps what it thought and said so far, but no calls (they may be half written).
      const toolCalls = looping || cut ? [] : callsOf(streamEvents);

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        stop: looping ? "length" : cut ? "aborted" : stopReason,
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
  async #deliver(queued: Queued): Promise<void> {
    this.#notifyQueueChange();
    await this.#push(userMessage(queued));
    this.#emit({ type: "delivered", text: queued.text });
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
      system: this.#system(this.#model),
      signal: this.#abortController!.signal,
      onProgress: (p) => this.#emit({ type: "compacting", ...p }),
    });
    if (!result) {
      this.#emit({ type: "compacted", keep: -1 }); // nothing done: the progress note goes
      return false;
    }
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
      const decision = this.#ext.beforeTool(event);
      const refused = decision === undefined ? undefined : "block" in decision ? decision.reason : await this.#ask(tc, decision.reason, signal);
      if (refused !== undefined) {
        this.#emit({ type: "tool_output", call: tc, output: refused });
        this.#emit({ type: "tool_end", call: tc });
        return { id: crypto.randomUUID(), role: "tool", content: refused, toolCallId: tc.id };
      }
    }

    try {
      if (signal.aborted) {
        throw new Error("Aborted by user");
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
      const answer = await tool.run(tc.args, ctx);
      if (signal.aborted) {
        throw new Error("Aborted by user");
      }
      const output = typeof answer === "string" ? answer : answer.text;
      const result = { name: tc.name, output: output, signal: signal };
      this.#ext?.emit("tool_result", result);
      this.#emit({ type: "tool_output", call: tc, output: result.output });
      this.#emit({ type: "tool_end", call: tc });
      const message: Message = { id: crypto.randomUUID(), role: "tool", content: result.output, toolCallId: tc.id };
      // Images (a vision tool's) go with the result: each provider carries them its own way.
      if (typeof answer !== "string" && answer.images !== undefined && answer.images.length > 0) message.images = answer.images;
      return message;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAborted = msg === "Aborted by user" || this.#abortController!.signal.aborted;
      this.#emit({ type: "tool_output", call: tc, output: isAborted ? "Aborted by user" : `ERROR: ${msg}` });
      this.#emit({ type: "tool_end", call: tc });
      return { id: crypto.randomUUID(), role: "tool", content: isAborted ? "Aborted by user" : `ERROR: ${msg}`, toolCallId: tc.id };
    }
  }

  /** Asks the user about a call and waits; undefined when allowed, else the tool's result. */
  async #ask(tc: ToolCall, reason: string, signal: AbortSignal): Promise<string | undefined> {
    if (this.#approvals.remembered(tc)) return undefined;
    const id = crypto.randomUUID();
    this.#emit({ type: "approval_request", id, call: tc, reason });
    const answer = await this.#approvals.wait(id, tc, signal);
    this.#emit({ type: "approval_end", id, allow: answer.allow, by: answer.by });
    if (answer.allow) return undefined;
    if (answer.by === "abort") return "Aborted by user";
    return answer.by === "timeout" ? "ERROR: denied: nobody answered the approval request, it did not run" : "ERROR: denied by the user: it did not run";
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
    const dropped = [...this.#steerQueue, ...this.#followUpQueue].map((q) => q.text);
    this.#steerQueue = [];
    this.#followUpQueue = [];
    this.#notifyQueueChange();
    return { reason: "aborted", dropped: dropped.length ? dropped : undefined };
  }
}

/** A user message waiting in a queue (or starting a run), with the images it carries. */
interface Queued {
  text: string;
  images?: Image[];
  seq?: number;
}

function userMessage(q: Queued): Message {
  const msg: Message = { id: crypto.randomUUID(), role: "user", content: q.text };
  if (q.images !== undefined && q.images.length > 0) msg.images = q.images;
  return msg;
}

function joinOf(events: StreamEvent[], kind: "text" | "thinking"): string {
  let out = "";
  for (const e of events) {
    if (e.type === kind) out += (e as { delta: string }).delta;
  }
  return out;
}

/** Sleeps `ms`; false when the signal cut it short. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal.aborted) return done(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      done(true);
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      done(false);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function errorOf(events: StreamEvent[]): string | undefined {
  const err = events.findLast((e) => e.type === "error");
  return err?.type === "error" ? err.message.slice(0, 200) : undefined;
}

function callsOf(events: StreamEvent[]): ToolCall[] {
  return events.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);
}
