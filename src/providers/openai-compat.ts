import type { Message, Provider, ProviderRequest, StreamEvent, Usage } from "../types.ts";
import { ThinkSplit } from "./think-split.ts";
import { ArgsWatcher } from "./partial-args.ts";

interface Delta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface Chunk {
  choices?: Array<{
    delta?: Delta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface Pending {
  id: string;
  name: string;
  args: string;
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  reasoningEffort?: "off" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  thinkingBudget?: number; // sent only when set: OpenAI itself rejects unknown fields
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
  const out: Usage = { input: raw.prompt_tokens ?? 0, output: raw.completion_tokens ?? 0 };
  const cached = raw.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cacheRead = cached;
  return out;
}

function stopFor(reason: string | null | undefined): StreamEvent & { type: "done" } {
  if (reason === "length") return { type: "done", stop: "length" };
  return { type: "done", stop: "end" };
}

export function openaiCompat(opts: OpenAiCompatOptions): Provider {
  const { baseUrl, apiKey } = opts;

  return {
    async models(signal: AbortSignal): Promise<string[]> {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!res.ok) return [];
      const list = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (list.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    },

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
        body: JSON.stringify(body(req, opts)),
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
      const watchers = new Map<number, ArgsWatcher>();
      const think = new ThinkSplit();
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
            const delta = choice.delta;
            if (delta?.reasoning_content) yield { type: "thinking", delta: delta.reasoning_content };
            else if (delta?.reasoning) yield { type: "thinking", delta: delta.reasoning };
            if (delta?.content) {
              for (const part of think.push(delta.content)) {
                if (part.kind === "thinking") yield { type: "thinking", delta: part.delta };
                else yield { type: "text", delta: part.delta };
              }
            }
            for (const tc of choice.delta?.tool_calls ?? []) {
              const index = tc.index ?? 0;
              const fresh = !pending.get(index)?.name;
              merge(pending, tc);
              // Say a call is coming as soon as its name is known (its args may take minutes), and
              // again as each string arg completes, so a path shows the moment it is written.
              const name = pending.get(index)?.name;
              if (fresh && name) yield { type: "tool_pending", name };
              const args = watchers.get(index) ?? watchers.set(index, new ArgsWatcher()).get(index)!;
              const done = args.push(tc.function?.arguments ?? "");
              if (done && name) yield { type: "tool_pending", name, args: done };
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          if (parser.done) break;
        }
        for (const p of think.flush()) {
          if (p.kind === "thinking") yield { type: "thinking", delta: p.delta };
          else yield { type: "text", delta: p.delta };
        }
      } catch {
        // Socket died mid-stream: any pending tool call has incomplete args, so drop it.
        yield { type: "done", stop: req.signal.aborted ? "aborted" : "error" };
        return;
      } finally {
        await reader.cancel().catch(() => {});
      }

      // Cut by the output limit: a call may still parse (some servers heal partial JSON) yet be
      // truncated, and a truncated write must never run. The loop asks the model to continue.
      if (finish === "length") {
        yield { type: "done", stop: "length", usage };
        return;
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

function body(req: ProviderRequest, opts: OpenAiCompatOptions): object {
  // Thinking goes back only for a reply cut by the output limit, so it can continue where it
  // stopped. Any other old thinking does harm: it holds drafts that differ from what was really
  // written, and a small model copies its last reasoning verbatim (a loop).
  const newest = req.messages.findLastIndex((m) => m.role === "assistant");
  const wired = req.messages.map((m, i) => wire(m, i === newest && m.stop === "length"));
  const messages = req.system ? [{ role: "system", content: req.system }, ...wired] : wired;
  return {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...((req.effort ?? opts.reasoningEffort) ? { reasoning_effort: req.effort ?? opts.reasoningEffort } : {}),
    ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
    // A request's budget wins (0 is "no cap" there, so it is sent); otherwise the configured one.
    ...(req.budget !== undefined
      ? { reasoning_budget_tokens: req.budget }
      : opts.thinkingBudget
        ? { reasoning_budget_tokens: opts.thinkingBudget }
        : {}),
    tools: req.tools.length
      ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }))
      : undefined,
  };
}

function wire(m: Message, withThinking: boolean): object {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  const reasoning = withThinking && m.thinking ? { reasoning_content: m.thinking } : {};
  if (m.toolCalls?.length) {
    return {
      role: m.role,
      content: m.content,
      ...reasoning,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content, ...reasoning };
}