import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openaiCompat } from "./openai-compat.ts";
import type { ProviderRequest, StreamEvent } from "../types.ts";

let server: ReturnType<typeof Bun.serve>;
let mode: "text" | "split-tool" | "hang" = "text";
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          const enc = (s: string): void => ctl.enqueue(new TextEncoder().encode(s));
          if (mode === "text") {
            enc(chunk({ content: "Hel" }));
            enc(chunk({ content: "lo, " }));
            enc(chunk({ content: "world" }));
            enc(finishChunk());
            enc("data: [DONE]\n\n");
            ctl.close();
          } else if (mode === "split-tool") {
            enc(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] }));
            enc(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/mai' } }] }));
            enc(chunk({ tool_calls: [{ index: 0, function: { arguments: 'n.ts"}' } }] }));
            enc(finishChunk());
            enc("data: [DONE]\n\n");
            ctl.close();
          } else {
            enc(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { name: "bash", arguments: '{"cmd' } }] }));
            enc(chunk({ content: "thinking" }));
            await Bun.sleep(30_000);
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server?.stop(true);
});

function setMode(m: "text" | "split-tool" | "hang"): void {
  mode = m;
}

function chunk(delta: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}\n\n`;
}

function finishChunk(): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }] })}\n\n`;
}

function mkReq(signal: AbortSignal): ProviderRequest {
  return {
    model: "test",
    system: "",
    messages: [{ id: "1", role: "user", content: "hi" }],
    tools: [],
    signal,
  };
}

async function collect(signal: AbortSignal): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of openaiCompat({ baseUrl, apiKey: "k" }).stream(mkReq(signal))) out.push(ev);
  return out;
}

describe("openai-compat", () => {
  test("1. text streams in order", async () => {
    setMode("text");
    const events = await collect(new AbortController().signal);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe(
      "Hello, world",
    );
    const done = events.at(-1);
    expect(done).toEqual({ type: "done", stop: "end" });
  });

  test("2. a tool call split across 3 SSE chunks is ONE tool_call", async () => {
    setMode("split-tool");
    const events = await collect(new AbortController().signal);
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "tool_call", call: { id: "call_1", name: "read", args: { path: "src/main.ts" } } });
    expect(events.at(-1)).toEqual({ type: "done", stop: "tool_use", usage: undefined });
  });

  test("3. abort mid-stream stops within 100ms with no partial tool_call", async () => {
    setMode("hang");
    const ac = new AbortController();
    let abortedAt = 0;
    const events: StreamEvent[] = [];
    setTimeout(() => {
      abortedAt = performance.now();
      ac.abort();
    }, 60);
    for await (const ev of openaiCompat({ baseUrl, apiKey: "k" }).stream(mkReq(ac.signal))) events.push(ev);
    // Measured from the abort itself: the spec is "stops iteration within 100ms".
    expect(performance.now() - abortedAt).toBeLessThan(100);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stop: "aborted" });
  });

  test("4. an already-aborted signal emits aborted without fetching", async () => {
    setMode("text");
    const ac = new AbortController();
    ac.abort();
    const events = await collect(ac.signal);
    expect(events).toEqual([{ type: "done", stop: "aborted" }]);
  });
});