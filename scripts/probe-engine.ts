// Probes a llama.cpp-style engine (Strata) for the facts Kinoko depends on.
// Usage: bun run scripts/probe-engine.ts [baseUrl] [model]
// Paste the printed report into docs/engines/strata-probe.txt.

const BASE = (process.argv[2] ?? "http://127.0.0.1:8081/v1").replace(/\/+$/, "");
const MODEL = process.argv[3] ?? "any";
const LIMIT = 4096;
const THINK_OPEN = "<think>";

interface Probe {
  firstByteMs: number; // ms to the first response byte, -1 when nothing arrived
  firstTokenMs: number; // ms to the first real delta, -1 when none arrived
  thinkFields: string[]; // delta keys that carried thinking
  fragments: number; // streamed tool-call argument fragments
  argsParse: boolean; // accumulated args parse as JSON
  usage: Record<string, unknown> | undefined; // last usage object seen
}

function blank(): Probe {
  return { firstByteMs: -1, firstTokenMs: -1, thinkFields: [], fragments: 0, argsParse: false, usage: undefined };
}

async function chat(body: Record<string, unknown>, abortAfterMs = 0): Promise<Probe> {
  const controller = new AbortController();
  if (abortAfterMs > 0) setTimeout(() => controller.abort(), abortAfterMs);
  const started = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch(() => null);
  if (!res?.ok || !res.body) return blank();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const thinkFields = new Set<string>();
  let buffer = "";
  let args = "";
  let fragments = 0;
  let usage: Record<string, unknown> | undefined;
  let firstByteMs = -1;
  let firstTokenMs = -1;

  // SSE lines: "data: {...}" frames, ": keep-alive" comments, and blank separators.
  const observe = (frame: string): void => {
    if (!frame.startsWith("data:")) return;
    const raw = frame.slice(5).trimStart();
    if (raw === "" || raw === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk.usage) usage = chunk.usage as Record<string, unknown>;
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    if (firstTokenMs < 0 && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)) {
      // The engine sends an empty first frame plus keep-alives straight away, so the
      // first byte proves nothing: time the first delta that actually carries output.
      firstTokenMs = performance.now() - started;
    }
    if (delta.reasoning_content) thinkFields.add("reasoning_content");
    if (delta.reasoning) thinkFields.add("reasoning");
    if (typeof delta.content === "string" && delta.content.includes(THINK_OPEN)) {
      thinkFields.add(`${THINK_OPEN} in content`);
    }
    for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      fragments++;
      const fn = tc.function as { arguments?: string } | undefined;
      args += fn?.arguments ?? "";
    }
  };

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- SSE frames must be read in order
      const step = await reader.read();
      if (step.done) break;
      if (firstByteMs < 0 && step.value.length > 0) firstByteMs = performance.now() - started;
      buffer += decoder.decode(step.value, { stream: true });
      const pieces = buffer.split("\n");
      buffer = pieces.pop() ?? "";
      for (const piece of pieces) observe(piece);
    }
  } catch {
    // cut short by the abort or a dead socket: report only what survived
  } finally {
    await reader.cancel().catch(() => {});
  }

  let argsParse = false;
  try {
    if (args !== "") argsParse = JSON.parse(args) !== null;
  } catch {
    argsParse = false;
  }
  return { firstByteMs, firstTokenMs, fragments, argsParse, usage, thinkFields: [...thinkFields] };
}

function line(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${label}: ${ok ? "OK" : "SUSPECT"} (${detail})\n`);
}

process.stdout.write(`engine ${BASE} model ${MODEL}\n`);

// 1. which delta field carries thinking
const thinkProbe = await chat({
  model: MODEL,
  stream: true,
  max_tokens: LIMIT,
  messages: [{ role: "user", content: "Think carefully, then answer: is 0.9 or 0.11 larger?" }],
});
line(
  "1. thinking field",
  thinkProbe.thinkFields.length > 0,
  thinkProbe.thinkFields.length > 0
    ? thinkProbe.thinkFields.join(", ")
    : "no thinking seen: treat all content as text",
);

// 2. streamed tool calls: fragmented? valid JSON?
const toolProbe = await chat({
  model: MODEL,
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: LIMIT,
  messages: [{ role: "user", content: "Read the file README.md." }],
  tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
});
line(
  "2. tool call streaming",
  toolProbe.argsParse,
  `${toolProbe.fragments} fragments, args ${toolProbe.argsParse ? "parse" : "do NOT parse"}`,
);

// 3. abort mid-generation, then check the engine really freed its slot
await chat(
  {
    model: MODEL,
    stream: true,
    max_tokens: LIMIT,
    messages: [{ role: "user", content: "Write a very long essay about mushrooms." }],
  },
  1500,
);
const followUp = await chat({
  model: MODEL,
  stream: true,
  max_tokens: 8,
  messages: [{ role: "user", content: "ping" }],
});
line(
  "3. abort stops generation",
  followUp.firstTokenMs >= 0 && followUp.firstTokenMs < 3000,
  `cut after 1.5s; next request first delta in ${Math.round(followUp.firstTokenMs)}ms (>=3000ms means the engine kept generating)`,
);

// 4. prompt prefix reuse: same long prefix, one extra message
const prefix = { role: "user", content: "A short fact about mycelium networks. ".repeat(600) };
const cold = await chat({
  model: MODEL,
  stream: true,
  max_tokens: 8,
  messages: [{ role: "system", content: "Answer briefly." }, prefix],
});
const warm = await chat({
  model: MODEL,
  stream: true,
  max_tokens: 8,
  messages: [{ role: "system", content: "Answer briefly." }, prefix, { role: "user", content: "Say OK again." }],
});
line(
  "4. prompt prefix reused",
  cold.firstTokenMs >= 0 && warm.firstTokenMs >= 0 && warm.firstTokenMs < cold.firstTokenMs / 2,
  `first delta: cold ${Math.round(cold.firstTokenMs)}ms, warm ${Math.round(warm.firstTokenMs)}ms (warm must be well under cold)`,
);

// 5. usage chunk (and cached-token details)
const usage = toolProbe.usage ?? thinkProbe.usage;
line(
  "5. usage chunk",
  usage !== undefined,
  usage === undefined ? "no usage chunk: cost stays unknown" : JSON.stringify(usage),
);