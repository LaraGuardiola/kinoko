import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { anthropic, wire } from "../../providers/anthropic.ts";
import type { Message, ProviderRequest, StreamEvent } from "../../types.ts";

let server: ReturnType<typeof Bun.serve>;
let script: string[] = [];
let hang = false;
let lastBody: Record<string, unknown> = {};
let lastHeaders: Headers = new Headers();
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      lastBody = (await request.json()) as Record<string, unknown>;
      lastHeaders = request.headers;
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          for (const frame of script) ctl.enqueue(new TextEncoder().encode(frame));
          if (hang) await Bun.sleep(30_000);
          ctl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

function sse(data: Record<string, unknown>): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

const start = sse({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 1 } } });
const blockStart = (index: number, block: Record<string, unknown>): string => sse({ type: "content_block_start", index, content_block: block });
const delta = (index: number, d: Record<string, unknown>): string => sse({ type: "content_block_delta", index, delta: d });
const end = (stop: string, extra: Record<string, unknown> = {}): string =>
  sse({ type: "message_delta", delta: { stop_reason: stop, ...extra }, usage: { output_tokens: 50 } }) + sse({ type: "message_stop" });

function req(signal: AbortSignal, model = "claude-opus-5-5"): ProviderRequest {
  return {
    model,
    system: "be brief",
    messages: [{ id: "1", role: "user", content: "hi" }],
    tools: [
      { name: "read", description: "r", schema: { type: "object" } },
      { name: "bash", description: "b", schema: { type: "object" } },
    ],
    signal,
  };
}

async function collect(signal = new AbortController().signal, model?: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of anthropic({ baseUrl, apiKey: "k", maxOutputTokens: 1000 }).stream(req(signal, model))) out.push(ev);
  return out;
}

const textOf = (events: StreamEvent[], kind: "text" | "thinking"): string =>
  events.map((e) => (e.type === kind ? e.delta : "")).join("");

describe("anthropic provider", () => {
  test("streams thinking and text in order, and hands back the signed blocks to replay", async () => {
    hang = false;
    script = [
      start,
      blockStart(0, { type: "thinking", thinking: "" }),
      delta(0, { type: "thinking_delta", thinking: "let me " }),
      delta(0, { type: "thinking_delta", thinking: "think" }),
      delta(0, { type: "signature_delta", signature: "SIG" }),
      blockStart(1, { type: "text", text: "" }),
      delta(1, { type: "text_delta", text: "Hel" }),
      delta(1, { type: "text_delta", text: "lo" }),
      end("end_turn"),
    ];
    const events = await collect();
    expect(textOf(events, "thinking")).toBe("let me think");
    expect(textOf(events, "text")).toBe("Hello");
    const replay = events.find((e) => e.type === "replay");
    expect(replay?.type === "replay" && replay.data).toEqual([
      { type: "thinking", thinking: "let me think", signature: "SIG" },
      { type: "text", text: "Hello" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "end" });
  });

  test("a tool call split across deltas is emitted once, complete", async () => {
    script = [
      start,
      blockStart(0, { type: "tool_use", id: "tu_1", name: "read", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: '{"pa' }),
      delta(0, { type: "input_json_delta", partial_json: 'th":"src/mai' }),
      delta(0, { type: "input_json_delta", partial_json: 'n.ts"}' }),
      end("tool_use"),
    ];
    const events = await collect();
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toEqual([{ type: "tool_call", call: { id: "tu_1", name: "read", args: { path: "src/main.ts" } } }]);
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "tool_use" });
    // The name is announced at the block start, then the path as soon as it is complete.
    expect(events[0]).toEqual({ type: "tool_pending", name: "read" });
    expect(events[1]).toEqual({ type: "tool_pending", name: "read", args: { path: "src/main.ts" } });
  });

  test("usage counts the whole prompt and prices it from models.json", async () => {
    script = [start, blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "x" }), end("end_turn")];
    const done = (await collect()).at(-1);
    expect(done?.type === "done" && done.usage).toMatchObject({ input: 100, output: 50, cacheRead: 80, cacheWrite: 10 });
    // 10 fresh * $4 + 50 out * $20 + 80 read * $0.2 + 10 write * $5, per million tokens.
    expect(done?.type === "done" ? done.usage?.cost : 0).toBeCloseTo((10 * 4 + 50 * 20 + 80 * 0.2 + 10 * 5) / 1e6, 12);
  });

  test("the request caches the system prompt, the last tool and the conversation, with adaptive thinking", async () => {
    script = [start, end("end_turn")];
    await collect();
    expect(lastHeaders.get("x-api-key")).toBe("k");
    expect(lastHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(lastBody.system).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
    const tools = lastBody.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(lastBody.cache_control).toEqual({ type: "ephemeral" });
    expect(lastBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(lastBody.max_tokens).toBe(1000);
  });

  test("a model with no server-side fallback is not asked for one", async () => {
    script = [start, end("end_turn")];
    await collect(undefined, "claude-haiku-5-5");
    expect(lastBody.fallbacks).toBeUndefined();
    expect(lastHeaders.get("anthropic-beta")).toBeNull();
    await collect();
    expect(lastBody.fallbacks).toBe("default");
  });

  test("abort mid-stream: no partial tool call, done aborted, fast", async () => {
    hang = true;
    script = [start, blockStart(0, { type: "tool_use", id: "tu_9", name: "bash", input: {} }), delta(0, { type: "input_json_delta", partial_json: '{"cmd' })];
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const t0 = performance.now();
    const events = await collect(ctl.signal);
    hang = false;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(events.some((e) => e.type === "tool_call" || e.type === "replay")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "aborted" });
  });

  test("truncation drops the tool call in flight; a refusal is an error", async () => {
    script = [start, blockStart(0, { type: "tool_use", id: "t", name: "bash", input: {} }), delta(0, { type: "input_json_delta", partial_json: '{"cm' }), end("max_tokens")];
    const cut = await collect();
    expect(cut.some((e) => e.type === "tool_call")).toBe(false);
    expect(cut.at(-1)).toMatchObject({ type: "done", stop: "length" });

    script = [start, end("refusal", { stop_details: { category: "cyber" } })];
    const refused = await collect();
    expect(refused.find((e) => e.type === "error")).toMatchObject({ message: "refused by the model (cyber)" });
    expect(refused.at(-1)).toMatchObject({ type: "done", stop: "error" });
  });

  test("tool calls declined before a mid-output fallback are not run", async () => {
    script = [
      start,
      blockStart(0, { type: "tool_use", id: "old", name: "bash", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: "{}" }),
      blockStart(1, { type: "fallback", from: { model: "a" }, to: { model: "b" } }),
      blockStart(2, { type: "tool_use", id: "new", name: "read", input: {} }),
      delta(2, { type: "input_json_delta", partial_json: '{"path":"x"}' }),
      end("tool_use"),
    ];
    const events = await collect();
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e.type === "tool_call" ? e.call.id : ""))).toEqual(["new"]);
  });
});

describe("anthropic wire format", () => {
  test("replayed blocks go back unchanged; tool results are grouped and every tool_use is answered", () => {
    const signed = [
      { type: "thinking", thinking: "t", signature: "S" },
      { type: "tool_use", id: "a", name: "read", input: { path: "x" } },
      { type: "tool_use", id: "b", name: "bash", input: { cmd: "ls" } },
    ];
    const messages: Message[] = [
      { id: "1", role: "user", content: "go" },
      { id: "2", role: "assistant", content: "", replay: signed, toolCalls: [] },
      { id: "3", role: "tool", content: "file", toolCallId: "a" },
      { id: "4", role: "user", content: "steer" },
    ];
    expect(wire(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: signed },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "file" },
          { type: "tool_result", tool_use_id: "b", content: "Aborted by user", is_error: true },
        ],
      },
      { role: "user", content: "steer" },
    ]);
  });

  test("messages from another provider become text and tool_use blocks; errors are flagged", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "go" },
      { id: "2", role: "assistant", content: "sure", toolCalls: [{ id: "c", name: "read", args: { path: "y" } }] },
      { id: "3", role: "tool", content: "ERROR: no such file", toolCallId: "c" },
    ];
    expect(wire(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "sure" }, { type: "tool_use", id: "c", name: "read", input: { path: "y" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "ERROR: no such file", is_error: true }] },
    ]);
  });

  test("a user message with images: base64 image blocks, then its text", () => {
    const messages: Message[] = [{ id: "1", role: "user", content: "what is [Image #1]?", images: [{ mime: "image/png", data: "QUJD" }] }];
    expect(wire(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "text", text: "what is [Image #1]?" },
        ],
      },
    ]);
  });
});
