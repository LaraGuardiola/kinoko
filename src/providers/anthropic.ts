// Anthropic Messages API: raw fetch plus a hand-written SSE reader, same Provider contract as
// openai-compat. Tool calls are emitted only once their JSON is complete, never on abort or
// truncation. The finished content blocks (signed thinking included) come back as a `replay`
// event so the next request can send them unchanged, which the API requires for thinking.

import type { Message, Provider, ProviderRequest, StreamEvent, Usage } from "../types.ts";
import { SseParser, transient } from "./openai-compat.ts";
import { ArgsWatcher } from "./partial-args.ts";
import models from "./models.json";

const VERSION = "2023-06-01";
// Server-side fallback: a request the safety classifiers decline is re-run on another model.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  maxOutputTokens?: number;
  reasoningEffort?: "off" | "low" | "medium" | "high";
}

interface ModelInfo {
  contextWindow: number;
  maxOutput: number;
  supportsCache: boolean;
  reasoning: string;
  /** Takes `fallbacks: "default"` (not every model has a server-side fallback). */
  fallback: boolean;
  price: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function modelInfo(model: string): ModelInfo | undefined {
  return (models as Record<string, ModelInfo>)[model];
}

type Block = Record<string, unknown> & { type: string };

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Event {
  type: string;
  index?: number;
  message?: { usage?: RawUsage };
  content_block?: Block;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_details?: { category?: string | null } | null;
  };
  usage?: RawUsage;
  error?: { type?: string; message?: string };
}

export function anthropic(opts: AnthropicOptions): Provider {
  return {
    // The models kinoko knows the window and prices of (models.json): the ones worth picking.
    async models(): Promise<string[]> {
      return Object.keys(models);
    },

    async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      if (req.signal.aborted) {
        yield { type: "done", stop: "aborted" };
        return;
      }
      const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": VERSION,
          ...(modelInfo(req.model)?.fallback ? { "anthropic-beta": FALLBACK_BETA } : {}),
        },
        body: JSON.stringify(body(req, opts)),
        signal: req.signal,
      }).catch(() => null);
      if (!res || !res.ok || !res.body) {
        if (req.signal.aborted) {
          yield { type: "done", stop: "aborted" };
          return;
        }
        yield { type: "error", message: `HTTP ${res?.status ?? 0}: ${(await res?.text().catch(() => "")) ?? ""}`, retry: !res || transient(res.status) };
        yield { type: "done", stop: "error" };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const blocks: Block[] = [];
      const json = new Map<number, string>(); // tool_use index -> partial JSON
      const watchers = new Map<number, ArgsWatcher>(); // tool_use index -> its completed string args
      const raw: RawUsage = {};
      let stop: string | undefined;
      let refusal: string | null | undefined;
      try {
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- SSE frames must be consumed in order.
          const step = await reader.read();
          if (step.done) break;
          for (const payload of parser.push(decoder.decode(step.value, { stream: true }))) {
            const ev = parse(payload);
            if (ev === undefined) continue;
            if (ev.type === "error") {
              const kind = ev.error?.type ?? "";
              yield { type: "error", message: ev.error?.message ?? "stream error", retry: kind === "overloaded_error" || kind === "api_error" };
              yield { type: "done", stop: "error" };
              return;
            }
            if (ev.type === "message_start") Object.assign(raw, ev.message?.usage);
            if (ev.type === "message_delta") {
              Object.assign(raw, ev.usage);
              stop = ev.delta?.stop_reason ?? stop;
              if (ev.delta?.stop_details) refusal = ev.delta.stop_details.category;
            }
            const i = ev.index ?? 0;
            if (ev.type === "content_block_start" && ev.content_block) {
              blocks[i] = { ...ev.content_block };
              // Say a call is coming as soon as its name is known: its input may take minutes.
              const block = ev.content_block as { type?: string; name?: string };
              if (block.type === "tool_use" && block.name) yield { type: "tool_pending", name: block.name };
            }
            if (ev.type === "content_block_delta") {
              const block = blocks[i];
              const d = ev.delta;
              if (!block || !d) continue;
              if (d.type === "text_delta" && d.text) {
                block.text = `${(block.text as string) ?? ""}${d.text}`;
                yield { type: "text", delta: d.text };
              } else if (d.type === "thinking_delta" && d.thinking) {
                block.thinking = `${(block.thinking as string) ?? ""}${d.thinking}`;
                yield { type: "thinking", delta: d.thinking };
              } else if (d.type === "signature_delta") {
                block.signature = d.signature;
              } else if (d.type === "input_json_delta") {
                json.set(i, (json.get(i) ?? "") + (d.partial_json ?? ""));
                // As each string arg completes, say so: a path shows the moment it is written.
                const args = watchers.get(i) ?? watchers.set(i, new ArgsWatcher()).get(i)!;
                const done = args.push(d.partial_json ?? "");
                const name = (block as { name?: string }).name;
                if (done && name) yield { type: "tool_pending", name, args: done };
              }
            }
          }
        }
      } catch (e) {
        // Socket died or the user aborted mid-stream: any tool call is incomplete, so drop it.
        if (!req.signal.aborted) yield { type: "error", message: `the connection closed mid-reply: ${e instanceof Error ? e.message : String(e)}`, retry: true };
        yield { type: "done", stop: req.signal.aborted ? "aborted" : "error" };
        return;
      } finally {
        await reader.cancel().catch(() => {});
      }

      const usage = toUsage(raw, req.model);
      if (stop === "refusal") {
        yield { type: "error", message: `refused by the model${refusal ? ` (${refusal})` : ""}` };
        yield { type: "done", stop: "error", usage };
        return;
      }
      if (stop === "max_tokens") {
        // Truncated: a tool call in flight has broken JSON, so nothing is called or replayed.
        yield { type: "done", stop: "length", usage };
        return;
      }

      // Only now are the tool inputs complete. Blocks before a fallback were declined: not run.
      const kept = afterFallback(blocks.filter((b) => b !== undefined));
      let calls = 0;
      for (const block of kept) {
        if (block.type !== "tool_use") continue;
        const index = blocks.indexOf(block);
        try {
          const text = json.get(index) ?? "";
          block.input = text === "" ? (block.input ?? {}) : JSON.parse(text);
        } catch {
          yield { type: "error", message: `invalid JSON args for tool ${String(block.name)}` };
          yield { type: "done", stop: "error", usage };
          return;
        }
        calls++;
        yield { type: "tool_call", call: { id: String(block.id), name: String(block.name), args: block.input } };
      }
      yield { type: "replay", data: kept.filter((b) => !(b.type === "text" && b.text === "")) };
      yield { type: "done", stop: calls > 0 ? "tool_use" : "end", usage };
    },
  };
}

/** After a mid-output fallback, thinking and tool calls before the last fallback block are void. */
function afterFallback(blocks: Block[]): Block[] {
  const last = blocks.findLastIndex((b) => b.type === "fallback");
  if (last < 0) return blocks;
  const voided = new Set(["thinking", "redacted_thinking", "tool_use"]);
  return blocks.filter((b, i) => i > last || !voided.has(b.type));
}

function parse(payload: string): Event | undefined {
  try {
    return JSON.parse(payload) as Event;
  } catch {
    return undefined;
  }
}

/** Kinoko's `input` is the whole prompt (as with openai-compat): fresh + cached + cache writes. */
function toUsage(raw: RawUsage, model: string): Usage {
  const read = raw.cache_read_input_tokens ?? 0;
  const write = raw.cache_creation_input_tokens ?? 0;
  const fresh = raw.input_tokens ?? 0;
  const output = raw.output_tokens ?? 0;
  const usage: Usage = { input: fresh + read + write, output, cacheRead: read, cacheWrite: write };
  const price = modelInfo(model)?.price;
  if (price) {
    usage.cost = (fresh * price.input + output * price.output + read * price.cacheRead + write * price.cacheWrite) / 1e6;
  }
  return usage;
}

function body(req: ProviderRequest, opts: AnthropicOptions): object {
  const info = modelInfo(req.model);
  const cache = info?.supportsCache !== false;
  const ephemeral = { type: "ephemeral" };
  const wanted = req.effort ?? opts.reasoningEffort;
  const effort = wanted === "off" ? "low" : wanted;
  const tools = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
    eager_input_streaming: true,
    ...(cache && i === req.tools.length - 1 ? { cache_control: ephemeral } : {}),
  }));
  return {
    model: req.model,
    max_tokens: opts.maxOutputTokens ?? info?.maxOutput ?? 64000,
    stream: true,
    // The static prefix gets its own breakpoint; the growing conversation is cached automatically.
    ...(req.system ? { system: [{ type: "text", text: req.system, ...(cache ? { cache_control: ephemeral } : {}) }] } : {}),
    ...(cache ? { cache_control: ephemeral } : {}),
    messages: wire(req.messages),
    ...(tools.length > 0 ? { tools } : {}),
    ...(info?.reasoning === "adaptive" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(info?.fallback ? { fallbacks: "default" } : {}),
  };
}

/**
 * Kinoko messages to the wire. Consecutive tool results become one user message, and every
 * tool_use gets a result (an aborted run may have left one without): the API rejects both gaps.
 */
export function wire(messages: Message[]): object[] {
  const out: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user" || m.role === "system") {
      if (m.images?.length) {
        const images = m.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } }));
        out.push({ role: "user", content: [...images, { type: "text", text: m.content }] });
      } else if (m.content !== "") out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") continue; // gathered right after their assistant message
    const content = Array.isArray(m.replay) ? (m.replay as Block[]) : plain(m);
    if (content.length === 0) continue;
    out.push({ role: "assistant", content });
    const ids = content.filter((b) => b.type === "tool_use").map((b) => String(b.id));
    if (ids.length === 0) continue;
    const results: object[] = [];
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role === "tool"; j++) {
      const t = messages[j]!;
      results.push({
        type: "tool_result",
        tool_use_id: t.toolCallId,
        content: t.content,
        ...(t.content.startsWith("ERROR:") ? { is_error: true } : {}),
      });
    }
    const answered = new Set(messages.slice(i + 1, j).map((t) => t.toolCallId));
    for (const id of ids) {
      if (!answered.has(id)) results.push({ type: "tool_result", tool_use_id: id, content: "Aborted by user", is_error: true });
    }
    out.push({ role: "user", content: results });
    i = j - 1;
  }
  return out;
}

/** An assistant message from another provider (or an aborted one): text and tool calls only. */
function plain(m: Message): Block[] {
  const blocks: Block[] = [];
  if (m.content !== "") blocks.push({ type: "text", text: m.content });
  for (const call of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
  return blocks;
}
