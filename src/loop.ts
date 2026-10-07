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
  | { type: "message_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
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

  constructor(opts: {
    provider: Provider;
    model: string;
    system: string;
    tools: Tool[];
    maxTurns: number;
    maxCost: number;
  }) {
    this.#provider = opts.provider;
    this.#model = opts.model;
    this.#system = opts.system;
    this.#tools = opts.tools;
    this.#maxTurns = opts.maxTurns;
    this.#maxCost = opts.maxCost;
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
      return await this.#run(text);
    } finally {
      this.#state = "idle";
      this.#abortController = null;
    }
  }

  async #run(initialPrompt: string): Promise<RunResult> {
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: initialPrompt };
    this.#messages.push(userMsg);
    this.#emit({ type: "run_start", prompt: initialPrompt });

    while (true) {
      if (this.#abortController!.signal.aborted) {
        return this.#handleAbort();
      }
      if (this.#turns >= this.#maxTurns) return { reason: "limit" };
      if (this.#cost >= this.#maxCost) return { reason: "limit" };

      this.#turns++;
      const req: ProviderRequest = {
        model: this.#model,
        system: this.#system,
        messages: this.#messages,
        tools: this.#tools,
        signal: this.#abortController!.signal,
      };

      const streamEvents: StreamEvent[] = [];
      let stopReason: StopReason = "end";
      let usage: Usage | undefined;

      // oxlint-disable-next-line no-await-in-loop -- consume SSE frames sequentially to preserve message/tool-call ordering
      for await (const ev of this.#provider.stream(req)) {
        if (this.#abortController!.signal.aborted) {
          this.#emitPartialAssistant(streamEvents);
          return this.#handleAbort();
        }
        streamEvents.push(ev);
        if (ev.type === "text") {
          this.#emit({ type: "message_delta", delta: ev.delta });
        } else if (ev.type === "done") {
          stopReason = ev.stop ?? "end";
          if (ev.usage) usage = ev.usage;
        }
      }

      if (this.#abortController!.signal.aborted) {
        this.#emitPartialAssistant(streamEvents);
        return this.#handleAbort();
      }

      const text = streamEvents.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
      const toolCalls = streamEvents.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        stop: stopReason,
        usage,
      };
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls;
      this.#messages.push(assistantMsg);
      this.#emit({ type: "message_end", message: assistantMsg });

      if (toolCalls.length === 0) {
        const steer = this.#steerQueue.shift();
        if (steer !== undefined) {
          this.#notifyQueueChange();
          this.#messages.push({ id: crypto.randomUUID(), role: "user", content: steer });
          continue;
        }
        const followUp = this.#followUpQueue.shift();
        if (followUp !== undefined) {
          this.#notifyQueueChange();
          this.#messages.push({ id: crypto.randomUUID(), role: "user", content: followUp });
          continue;
        }
        const finalReason = stopReason === "aborted" ? "aborted" : stopReason === "length" ? "limit" : stopReason === "error" ? "error" : "done";
        return { reason: finalReason };
      }

      const valid = toolCalls.filter((tc) => this.#tools.some((t) => t.name === tc.name));
      const invalid = toolCalls.filter((tc) => !this.#tools.some((t) => t.name === tc.name));

      for (const tc of invalid) {
        this.#malformedCount++;
        this.#messages.push({
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
        this.#messages.push(msg);
      }
      for (const tc of rw) {
        // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
        const msg = await this.#runTool(tc);
        this.#messages.push(msg);
      }

      if (this.#abortController!.signal.aborted) {
        return this.#handleAbort();
      }

      const steerAfter = this.#steerQueue.shift();
      if (steerAfter !== undefined) {
        this.#notifyQueueChange();
        this.#messages.push({ id: crypto.randomUUID(), role: "user", content: steerAfter });
        continue;
      }
    }
  }

  async #runTool(tc: ToolCall): Promise<Message> {
    const tool = this.#tools.find((t) => t.name === tc.name)!;
    this.#emit({ type: "tool_start", call: tc });
    const ctx: ToolContext = { signal: this.#abortController!.signal, cwd: process.cwd() };
    try {
      if (this.#abortController!.signal.aborted) {
        throw new Error("Aborted by user");
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential execution required so the next model request sees tool results in order
      const output = await tool.run(tc.args, ctx);
      if (this.#abortController!.signal.aborted) {
        throw new Error("Aborted by user");
      }
      this.#emit({ type: "tool_output", call: tc, output });
      this.#emit({ type: "tool_end", call: tc });
      return { id: crypto.randomUUID(), role: "tool", content: output, toolCallId: tc.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAborted = msg === "Aborted by user" || this.#abortController!.signal.aborted;
      this.#emit({ type: "tool_output", call: tc, output: isAborted ? "Aborted by user" : `ERROR: ${msg}` });
      this.#emit({ type: "tool_end", call: tc });
      return { id: crypto.randomUUID(), role: "tool", content: isAborted ? "Aborted by user" : `ERROR: ${msg}`, toolCallId: tc.id };
    }
  }

  #emitPartialAssistant(streamEvents: StreamEvent[]): void {
    const hasText = streamEvents.some((e) => e.type === "text");
    if (!hasText) return;
    const text = streamEvents.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    const calls = streamEvents.filter((e) => e.type === "tool_call").map((e) => (e as { call: ToolCall }).call);
    const msg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      stop: "aborted",
    };
    if (calls.length > 0) msg.toolCalls = calls;
    this.#messages.push(msg);
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
