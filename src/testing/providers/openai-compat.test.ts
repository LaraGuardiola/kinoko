import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listModels, openaiCompat, transient } from "../../providers/openai-compat.ts";
import type { ProviderRequest, StreamEvent } from "../../types.ts";

let server: ReturnType<typeof Bun.serve>;
let mode: "text" | "split-tool" | "length-tool" | "hang" = "text";
let lastBody: Record<string, unknown> = {};
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      lastBody = JSON.parse(await request.text()) as Record<string, unknown>;
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
          } else if (mode === "length-tool") {
            // A server that heals partial JSON: the args parse, but the reply was cut by max_tokens.
            enc(chunk({ tool_calls: [{ index: 0, id: "call_2", function: { name: "write", arguments: '{"path":"a.ts","content":"half"}' } }] }));
            enc(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "length" }] })}\n\n`);
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

function setMode(m: "text" | "split-tool" | "length-tool" | "hang"): void {
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
    // The name is announced on the first chunk, then the path the moment its closing quote arrives,
    // both long before the call itself.
    expect(events.filter((e) => e.type === "tool_pending")).toEqual([
      { type: "tool_pending", name: "read" },
      { type: "tool_pending", name: "read", args: { path: "src/main.ts" } },
    ]);
    expect(events.findIndex((e) => e.type === "tool_pending")).toBe(0);
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
describe("openai-compat: truncation, thinking and effort", () => {
  test("a tool call cut by the output limit never runs, even when its JSON parses", async () => {
    setMode("length-tool");
    const events = await collect(new AbortController().signal);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "length" });
  });

  test("replay none: thinking goes back only for a newest reply cut by the output limit; the request effort overrides the config", async () => {
    setMode("text");
    const provider = openaiCompat({ baseUrl, apiKey: "k", reasoningEffort: "low", thinkingBudget: 2048, thinkingReplay: "none" });
    const req: ProviderRequest = {
      ...mkReq(new AbortController().signal),
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "draft", thinking: "an old draft of the file" },
        { id: "3", role: "user", content: "next" },
        { id: "4", role: "assistant", content: "", thinking: "let me see", stop: "length" },
        { id: "5", role: "user", content: "go" },
      ],
      effort: "off",
    };
    for await (const _ of provider.stream(req)) void _;
    const messages = lastBody.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: "assistant", content: "draft" });
    expect(messages[3]).toEqual({ role: "assistant", content: "", reasoning_content: "let me see" });
    // A finished newest reply keeps its thinking to itself: a small model copies it verbatim.
    const done = { ...req, messages: [...req.messages.slice(0, 3), { id: "4", role: "assistant" as const, content: "ok", thinking: "x" }] };
    for await (const _ of provider.stream(done)) void _;
    expect((lastBody.messages as Array<Record<string, unknown>>)[3]).toEqual({ role: "assistant", content: "ok" });
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(lastBody.reasoning_effort).toBe("off");
    expect(lastBody.reasoning_budget_tokens).toBe(2048);
  });

  test("with tools, several calls per reply are asked for; without tools, nothing is said about them", async () => {
    setMode("text");
    const provider = openaiCompat({ baseUrl, apiKey: "k" });
    const tools = [{ name: "read", description: "read", schema: { type: "object" } }];
    for await (const _ of provider.stream({ ...mkReq(new AbortController().signal), tools })) void _;
    expect(lastBody.parallel_tool_calls).toBe(true);
    for await (const _ of provider.stream(mkReq(new AbortController().signal))) void _;
    expect(lastBody.parallel_tool_calls).toBeUndefined();
  });

  test("a user message with images: a text part, then data-URL image_url parts", async () => {
    setMode("text");
    const provider = openaiCompat({ baseUrl, apiKey: "k" });
    const messages = [{ id: "1", role: "user" as const, content: "see [Image #1]", images: [{ mime: "image/jpeg", data: "QUJD" }] }];
    for await (const _ of provider.stream({ ...mkReq(new AbortController().signal), messages: messages })) void _;
    expect((lastBody.messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "see [Image #1]" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
      ],
    });
  });

  test("replay turn (the default): the steps since the user's last message keep their thinking, older ones do not", async () => {
    setMode("text");
    const provider = openaiCompat({ baseUrl, apiKey: "k" });
    const req: ProviderRequest = {
      ...mkReq(new AbortController().signal),
      messages: [
        { id: "1", role: "user", content: "build it" },
        { id: "2", role: "assistant", content: "", thinking: "an old plan", toolCalls: [{ id: "a", name: "read", args: {} }] },
        { id: "3", role: "tool", content: "ok", toolCallId: "a" },
        { id: "4", role: "user", content: "what happened?" },
        { id: "5", role: "assistant", content: "", thinking: "I was cut off; next: input/", toolCalls: [{ id: "b", name: "bash", args: {} }] },
        { id: "6", role: "tool", content: "files", toolCallId: "b" },
        { id: "7", role: "user", content: "[kinoko] Your last reply had no answer" }, // a nudge is not the user
        { id: "8", role: "assistant", content: "writing input/", thinking: "input/ next, then audio/" },
      ],
    };
    for await (const _ of provider.stream(req)) void _;
    const messages = lastBody.messages as Array<Record<string, unknown>>;
    expect(messages[1]!.reasoning_content).toBeUndefined(); // before "what happened?": dropped
    expect(messages[4]!.reasoning_content).toBe("I was cut off; next: input/");
    expect(messages[7]!.reasoning_content).toBe("input/ next, then audio/");
  });

  test("a server that never answers is named, with how long it took and why", async () => {
    const provider = openaiCompat({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" });
    const events: StreamEvent[] = [];
    for await (const e of provider.stream(mkReq(new AbortController().signal))) events.push(e);
    const error = events.find((e) => e.type === "error");
    expect(error?.type === "error" && error.message).toMatch(/^no answer from 127\.0\.0\.1:9 after \d+s: .+\(a server timeout, or the server stopped\?\)$/);
    expect(events.at(-1)).toEqual({ type: "done", stop: "error" });
    expect(error?.type === "error" && error.retry).toBe(true);
  });

  test("transient statuses are marked for a retry; a bad request is not", async () => {
    const statuses = Bun.serve({ port: 0, fetch: (req) => new Response("no", { status: Number(new URL(req.url).pathname.split("/")[1]) }) });
    const errorAt = async (status: number): Promise<StreamEvent | undefined> => {
      const provider = openaiCompat({ baseUrl: `http://localhost:${statuses.port}/${status}/v1`, apiKey: "k" });
      for await (const e of provider.stream(mkReq(new AbortController().signal))) if (e.type === "error") return e;
      return undefined;
    };
    expect(await errorAt(503)).toEqual({ type: "error", message: "HTTP 503: no", retry: true });
    expect(await errorAt(429)).toMatchObject({ retry: true });
    expect(await errorAt(400)).toMatchObject({ retry: false });
    expect(transient(500) && transient(408) && !transient(401) && !transient(404)).toBe(true);
    statuses.stop(true);
  });
});

describe("listModels: each model's context window, wherever the server puts it", () => {
  const lists: Record<string, unknown> = {
    strata: { data: [{ id: "coder", meta: { n_ctx: 122880 } }] },
    router: { data: [{ id: "small", status: { args: ["--port", "0", "--ctx-size", "65536"] } }, { id: "c", status: { args: ["-c", "4096"] } }] },
    single: { data: [{ id: "one", meta: { n_ctx_train: 262144 } }] }, // training size: never the window
  };
  const windows = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const [, style, tail] = path.split("/"); // /<style>/v1/models or /<style>/props
      if (path.endsWith("/v1/models")) return Response.json(lists[style ?? ""] ?? { data: [] });
      if (tail === "props" && style === "single") return Response.json({ default_generation_settings: { n_ctx: 32768 } });
      return new Response("no", { status: 404 });
    },
  });
  const at = (style: string): Promise<unknown> => listModels(`http://localhost:${windows.port}/${style}/v1`, "", AbortSignal.timeout(5000));

  test("Strata's meta.n_ctx, llama.cpp router launch args, a single llama.cpp server's /props", async () => {
    expect(await at("strata")).toEqual([{ id: "coder", contextWindow: 122880 }]);
    expect(await at("router")).toEqual([{ id: "small", contextWindow: 65536 }, { id: "c", contextWindow: 4096 }]);
    expect(await at("single")).toEqual([{ id: "one", contextWindow: 32768 }]);
    windows.stop(true);
  });
});
