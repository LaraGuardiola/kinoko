import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openaiCompat } from "./openai-compat.ts";
import { ThinkSplit } from "./think-split.ts";
import type { OpenAiCompatOptions } from "./openai-compat.ts";
import type { ProviderRequest, StreamEvent } from "../types.ts";

type Emit = (frame: string) => void;
type Script = (emit: Emit, wait: (ms: number) => Promise<void>) => Promise<void>;

let server: ReturnType<typeof Bun.serve>;
let script: Script;
let lastBody: Record<string, unknown>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      lastBody = (await request.json()) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          const enc = new TextEncoder();
          await script(
            (frame) => ctl.enqueue(enc.encode(frame)),
            (ms) => new Promise((r) => setTimeout(r, ms)),
          );
          ctl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

function delta(d: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`;
}

function usageChunk(u: unknown): string {
  return `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

async function collect(opts: Partial<OpenAiCompatOptions> = {}): Promise<StreamEvent[]> {
  const req: ProviderRequest = {
    model: "any",
    system: "",
    messages: [{ id: "1", role: "user", content: "hi" }],
    tools: [],
    signal: new AbortController().signal,
  };
  const provider = openaiCompat({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "k", ...opts });
  const out: StreamEvent[] = [];
  for await (const ev of provider.stream(req)) out.push(ev);
  return out;
}

function joined(events: StreamEvent[], kind: "text" | "thinking"): string {
  return events
    .filter((e) => e.type === kind)
    .map((e) => (e as { delta: string }).delta)
    .join("");
}

describe("phase 4b: local engine compatibility", () => {
  test("1. reasoning_content and reasoning deltas become thinking, never text", async () => {
    script = async (emit) => {
      emit(delta({ reasoning_content: "0.9 > " }));
      emit(delta({ reasoning: "0.11" }));
      emit(delta({ content: "Answer: 0.9" }));
      emit(DONE);
    };
    const events = await collect();
    expect(joined(events, "thinking")).toBe("0.9 > 0.11");
    expect(joined(events, "text")).toBe("Answer: 0.9");
    expect(joined(events, "text")).not.toContain("0.11");
  });

  test("2. <think> split across chunk boundaries; text stays clean", async () => {
    script = async (emit) => {
      emit(delta({ content: "before<thi" }));
      emit(delta({ content: "nk>hidden reasoning</thi" }));
      emit(delta({ content: "nk> after" }));
      emit(DONE);
    };
    const events = await collect();
    expect(joined(events, "thinking")).toBe("hidden reasoning");
    expect(joined(events, "text")).toBe("before after");
  });

  test("2b. the splitter stays disarmed until a tag is seen", () => {
    const plain = new ThinkSplit();
    // No tag in sight: content is emitted at once, nothing is held back.
    expect(plain.push("hello")).toEqual([{ kind: "text", delta: "hello" }]);
    // A delta that may be the start of a tag is held, and no thinking event appears.
    expect(plain.push(" <thi")).toEqual([{ kind: "text", delta: " " }]);
    expect(plain.push("nk>why</think>yes")).toEqual([
      { kind: "thinking", delta: "why" },
      { kind: "text", delta: "yes" },
    ]);
    // An unterminated tag keeps streaming as thinking until the close tag or the end.
    const cut = new ThinkSplit();
    expect(cut.push("<think>unfinished")).toEqual([{ kind: "thinking", delta: "unfinished" }]);
    expect(cut.push(" tail")).toEqual([{ kind: "thinking", delta: " tail" }]);
    expect(cut.flush()).toEqual([]);
  });

  test("3. reasoning_effort and max_tokens are sent only when configured", async () => {
    script = async (emit) => {
      emit(delta({ content: "x" }));
      emit(DONE);
    };
    await collect();
    expect(lastBody.stream_options).toEqual({ include_usage: true });
    expect(lastBody).not.toHaveProperty("reasoning_effort");
    expect(lastBody).not.toHaveProperty("max_tokens");

    await collect({ reasoningEffort: "high", maxOutputTokens: 4096 });
    expect(lastBody.reasoning_effort).toBe("high");
    expect(lastBody.max_tokens).toBe(4096);
  });

  test("4. a first byte after 3s does not time out", async () => {
    script = async (emit, wait) => {
      await wait(3000);
      emit(delta({ content: "late" }));
      emit(DONE);
    };
    const started = performance.now();
    const events = await collect();
    expect(performance.now() - started).toBeGreaterThan(2900);
    expect(joined(events, "text")).toBe("late");
    expect(events.at(-1)).toEqual({ type: "done", stop: "end", usage: undefined });
  });

  test("5. usage chunk maps prompt/completion tokens and cached tokens", async () => {
    script = async (emit) => {
      emit(delta({ content: "x" }));
      emit(usageChunk({ prompt_tokens: 120, completion_tokens: 34, prompt_tokens_details: { cached_tokens: 96 } }));
      emit(DONE);
    };
    expect((await collect()).at(-1)).toEqual({
      type: "done",
      stop: "end",
      usage: { input: 120, output: 34, cacheRead: 96 },
    });

    script = async (emit) => {
      emit(delta({ content: "x" }));
      emit(usageChunk({ prompt_tokens: 12, completion_tokens: 3 }));
      emit(DONE);
    };
    expect((await collect()).at(-1)).toEqual({
      type: "done",
      stop: "end",
      usage: { input: 12, output: 3 },
    });
  });
});