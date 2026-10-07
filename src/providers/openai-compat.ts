import type { Message, Provider, ProviderRequest, StreamEvent, Usage } from "../types.ts";

interface Delta {
  content?: string;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface Chunk {
  choices?: Array<{
    delta?: Delta;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface Pending {
  id: string;
  name: string;
  args: string;
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
}

/** Splits an SSE byte stream into complete `data:` payloads. */
export class SseParser {
  private buffer = "";
  private seenDone = false;

  /** Returns every complete data payload in this chunk; keeps the remainder buffered. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const payload = this.dataOf(raw);
      if (payload === undefined) continue;
      if (payload === "[DONE]") this.seenDone = true;
      else out.push(payload);
    }
    return out;
  }

  /** Flushes a trailing event that was not terminated by a blank line. */
  flush(): string[] {
    const raw = this.buffer;
    this.buffer = "";
    const payload = this.dataOf(raw);
    if (payload === undefined || payload === "[DONE]") return [];
    return [payload];
  }

  get done(): boolean {
    return this.seenDone;
  }

  private dataOf(raw: string): string | undefined {
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length ? data.join("\n") : undefined;
  }
}

function toUsage(raw: Chunk["usage"]): Usage | undefined {
  if (!raw) return undefined;
  const input = raw.prompt_tokens ?? 0;
  const output = raw.completion_tokens ?? 0;
  return { input, output };
}

function stopFor(reason: string | null | undefined): StreamEvent & { type: "done" } {
  if (reason === "length") return { type: "done", stop: "length" };
  return { type: "done", stop: "end" };
}

export function openaiCompat(opts: OpenAiCompatOptions): Provider {
  const { baseUrl, apiKey } = opts;

  return {
    async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      if (req.signal.aborted) {
        yield { type: "done", stop: "aborted" };
        return;
      }
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body(req)),
        signal: req.signal,
      }).catch(() => null);
      if (!res || !res.ok || !res.body) {
        yield { type: "error", message: `HTTP ${res?.status ?? 0}: ${await res?.text().catch(() => "") ?? ""}` };
        yield { type: "done", stop: "error" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const pending = new Map<number, Pending>();
      let finish: string | null | undefined;
      let usage: Usage | undefined;

      try {
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- SSE frames must be consumed in order.
          const step = await reader.read();
          if (step.done) break;
          for (const payload of parser.push(decoder.decode(step.value, { stream: true }))) {
            const chunk = parseChunk(payload);
            if (!chunk) continue;
            if (chunk.usage) usage = toUsage(chunk.usage);
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) yield { type: "text", delta: choice.delta.content };
            for (const tc of choice.delta?.tool_calls ?? []) merge(pending, tc);
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          if (parser.done) break;
        }
      } catch {
        // Socket died mid-stream: any pending tool call has incomplete args, so drop it.
        yield { type: "done", stop: req.signal.aborted ? "aborted" : "error" };
        return;
      } finally {
        await reader.cancel().catch(() => {});
      }

      // Only now, with the stream fully consumed, are the tool-call args complete.
      let broken = false;
      for (const key of [...pending.keys()].toSorted((a, b) => a - b)) {
        const p = pending.get(key);
        if (!p) continue;
        let args: unknown;
        try {
          args = p.args ? JSON.parse(p.args) : {};
        } catch {
          broken = true;
          yield { type: "error", message: `invalid JSON args for tool ${p.name}` };
          continue;
        }
        yield { type: "tool_call", call: { id: p.id, name: p.name, args } };
      }
      if (broken) {
        yield { type: "done", stop: "error", usage };
        return;
      }
      if (pending.size) yield { type: "done", stop: "tool_use", usage };
      else yield { ...stopFor(finish), usage };
    },
  };
}

function parseChunk(payload: string): Chunk | undefined {
  try {
    return JSON.parse(payload) as Chunk;
  } catch {
    return undefined;
  }
}

function merge(pending: Map<number, Pending>, tc: NonNullable<Delta["tool_calls"]>[number]): void {
  const index = tc.index ?? 0;
  const prev = pending.get(index);
  const next: Pending = {
    id: tc.id ?? prev?.id ?? "",
    name: tc.function?.name ?? prev?.name ?? "",
    args: (prev?.args ?? "") + (tc.function?.arguments ?? ""),
  };
  pending.set(index, next);
}

function body(req: ProviderRequest): object {
  const messages = req.system
    ? [{ role: "system", content: req.system }, ...req.messages.map(wire)]
    : req.messages.map(wire);
  return {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    tools: req.tools.length
      ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }))
      : undefined,
  };
}

function wire(m: Message): object {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  if (m.toolCalls?.length) {
    return {
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}