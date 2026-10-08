import { expect, test, describe } from "bun:test";
import {
  RESERVE,
  SUMMARY_HEADING,
  compactHistory,
  contextTokens,
  historyTokens,
  isContextOverflow,
  shouldCompact,
} from "../compact.ts";
import { Agent } from "../loop.ts";
import type { Message, Provider, StreamEvent } from "../types.ts";

/** Records what the summarizer was asked, and answers with `text`. */
function summarizer(text: string, asked: string[] = []): Provider {
  return {
    stream: async function* (req): AsyncIterable<StreamEvent> {
      asked.push(req.messages[0]!.content);
      yield { type: "text", delta: text };
      yield { type: "done", stop: "end" };
    },
  };
}

function user(id: string, chars: number): Message {
  return { id, role: "user", content: `${id} ${"x".repeat(chars)}` };
}

/** A history whose head is much larger than its tail. */
function history(): Message[] {
  return [
    user("u1", 60_000),
    { id: "a1", role: "assistant", content: "early answer" },
    user("u2", 40_000),
    user("u3", 4000),
    { id: "u4", role: "user", content: "the most recent question" },
  ];
}

describe("compaction", () => {
  test("1. fires late: only below contextWindow - reserve", () => {
    const small = [user("a", 4000)];
    expect(shouldCompact(small, 100_000)).toBe(false);
    const window = historyTokens(history()) + RESERVE;
    expect(shouldCompact(history(), window)).toBe(false);
    expect(shouldCompact(history(), window - 1)).toBe(true);
    expect(shouldCompact([], 0)).toBe(false);
  });

  test("1b. the server's count for the newest reply is the base; only what came after is estimated", () => {
    const answered: Message = { id: "a", role: "assistant", content: "ok", usage: { input: 90_000, output: 500 } };
    const after = user("t", 4000);
    expect(contextTokens([user("u", 40), answered, after])).toBe(90_500 + historyTokens([after]));
    // chars/4 alone would say ~1k tokens here and never compact a 100k-token prompt.
    expect(shouldCompact([user("u", 40), answered, after], 100_000)).toBe(true);
  });

  test("1c. a compacted tail drops its usage: it counted a prompt that no longer exists", async () => {
    const messages = history();
    messages[1]!.usage = { input: 200_000, output: 10 };
    const result = await compactHistory([...messages, { ...messages[1]!, id: "a2" }, user("u5", 10)], {
      provider: summarizer("Objective: x"),
      model: "m",
      system: "",
      signal: new AbortController().signal,
      tailTokens: 100,
    });
    expect(result!.view.some((m) => m.usage !== undefined)).toBe(false);
  });

  test("2. keeps the tail verbatim and replaces the head with one summary", async () => {
    const messages = history();
    const result = await compactHistory(messages, {
      provider: summarizer("Objective: x\nDecisions: y\nWork State: z\nNext Step: w\nRelevant Files: f.ts"),
      model: "m",
      system: "sys",
      signal: new AbortController().signal,
      tailTokens: 5000,
    });
    expect(result).toBeDefined();
    expect(result!.view[0]!.content).toStartWith(SUMMARY_HEADING);
    expect(result!.view[0]!.role).toBe("user");
    // Everything from keepFrom on is the original object, byte for byte.
    const tail = messages.slice(messages.findIndex((m) => m.id === result!.keepFrom));
    expect(result!.view.slice(1)).toEqual(tail);
    expect(result!.view.map((m) => m.content)).toContain("the most recent question");
  });

  test("2b. the kept tail loses its replayed thinking: it was bound to the summarized history", async () => {
    const messages = history();
    messages[messages.length - 2] = { id: "a2", role: "assistant", content: "kept", replay: [{ type: "thinking", signature: "S" }] };
    const result = await compactHistory(messages, {
      provider: summarizer("summary"),
      model: "m",
      system: "sys",
      signal: new AbortController().signal,
      tailTokens: 5000,
    });
    const kept = result!.view.find((m) => m.id === "a2");
    expect(kept?.content).toBe("kept");
    expect(kept?.replay).toBeUndefined();
  });

  test("3. a previous summary is passed in to be merged, not dropped", async () => {
    const asked: string[] = [];
    const messages: Message[] = [
      { id: "s0", role: "user", content: `${SUMMARY_HEADING}\nObjective: old goal\n</compacted_summary>` },
      user("u1", 60_000),
      user("u2", 30_000),
      user("u3", 4000),
      user("u4", 2000),
    ];
    const result = await compactHistory(messages, {
      provider: summarizer("Objective: new goal", asked),
      model: "m",
      system: "sys",
      signal: new AbortController().signal,
      tailTokens: 4000,
    });
    expect(result).toBeDefined();
    expect(asked[0]).toContain("<previous_summary>");
    expect(asked[0]).toContain("Objective: old goal");
    expect(asked[0]).toContain("Merge it");
    // One new summary replaces the old one; the transcript text of the old summary is not resent.
    expect(result!.view[0]!.content).toBe(`${SUMMARY_HEADING}\nObjective: new goal\n</compacted_summary>`);
    expect(result!.view.filter((m) => m.content.includes(SUMMARY_HEADING))).toHaveLength(1);
  });

  test("4. aborting during compaction changes nothing", async () => {
    const messages = history();
    const snapshot = structuredClone(messages);
    const controller = new AbortController();
    const slow: Provider = {
      stream: async function* (req): AsyncIterable<StreamEvent> {
        yield { type: "text", delta: "partial" };
        await new Promise<void>((r) => setTimeout(r, 20));
        if (req.signal.aborted) return;
        yield { type: "done", stop: "end" };
      },
    };
    const running = compactHistory(messages, {
      provider: slow,
      model: "m",
      system: "sys",
      signal: controller.signal,
      tailTokens: 5000,
    });
    await new Promise<void>((r) => setTimeout(r, 5));
    controller.abort();
    expect(await running).toBeUndefined();
    expect(messages).toEqual(snapshot);
  });

  test("5. nothing to compact: an aborted signal, an empty history, or all-tail", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = { provider: summarizer("x"), model: "m", system: "s", signal: controller.signal };
    expect(await compactHistory(history(), opts)).toBeUndefined();
    const live = { ...opts, signal: new AbortController().signal };
    expect(await compactHistory([], live)).toBeUndefined();
    expect(await compactHistory([user("only", 100)], { ...live, tailTokens: 5000 })).toBeUndefined();
  });

  test("6. the tail never starts with a tool result whose call was summarized away", async () => {
    const messages: Message[] = [
      user("u1", 60_000),
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { id: "t1", role: "tool", content: "tool output", toolCallId: "c1" },
      user("u2", 2000),
    ];
    // A tail budget that reaches t1 but not a1: the boundary would orphan the tool result.
    const result = await compactHistory(messages, {
      provider: summarizer("Work State: read the file"),
      model: "m",
      system: "s",
      signal: new AbortController().signal,
      tailTokens: 130,
    });
    expect(result!.keepFrom).toBe("u2");
    expect(result!.view.slice(1).every((m) => m.role !== "tool")).toBe(true);
  });

  test("6b. a generous tail keeps an assistant call together with its tool result", async () => {
    const messages: Message[] = [
      user("u1", 60_000),
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { id: "t1", role: "tool", content: "tool output", toolCallId: "c1" },
      user("u2", 2000),
    ];
    const result = await compactHistory(messages, {
      provider: summarizer("Work State: read the file"),
      model: "m",
      system: "s",
      signal: new AbortController().signal,
      tailTokens: 5000,
    });
    const tail = result!.view.slice(1);
    expect(tail.map((m) => m.id)).toEqual(["a1", "t1", "u2"]);
    for (const msg of tail.filter((x) => x.role === "tool")) {
      expect(tail.some((a) => (a.toolCalls ?? []).some((c) => c.id === msg.toolCallId))).toBe(true);
    }
  });

  test("7. provider overflow errors are recognized", () => {
    expect(isContextOverflow("maximum context length is 8192 tokens")).toBe(true);
    expect(isContextOverflow("This model's maximum context length is 8192 tokens")).toBe(true);
    expect(isContextOverflow("context_length_exceeded")).toBe(true);
    expect(isContextOverflow("HTTP 500: internal error")).toBe(false);
  });

  test("8. the Agent compacts before an oversized request; aborting mid-compaction is a no-op", async () => {
    const big = history();
    let summaries = 0;
    let pauseMs = 30;
    const provider: Provider = {
      stream: async function* (req): AsyncIterable<StreamEvent> {
        const isSummary = req.messages[0]?.content.startsWith("Compact the following") ?? false;
        if (isSummary) {
          summaries++;
          yield { type: "text", delta: "Objective: keep going" };
          // oxlint-disable-next-line no-await-in-loop -- the fake engine streams slowly on purpose
          await new Promise<void>((r) => setTimeout(r, pauseMs));
          if (req.signal.aborted) return;
          yield { type: "done", stop: "end" };
          return;
        }
        yield { type: "text", delta: "answer" };
        yield { type: "done", stop: "end" };
      },
    };
    // The session hands back an oversized history and ignores appends: only the Agent matters here.
    const fakeSession = {
      append: async (m: Message) => m,
      view: () => big,
      markCompaction: async (m: Message) => m,
    } as never;
    const make = (): Agent =>
      new Agent({
        provider,
        model: "m",
        system: "s",
        tools: [],
        maxTurns: 5,
        maxCost: 10,
        contextWindow: historyTokens(big),
        session: fakeSession,
      });

    // Abort while the summary is still streaming: history must be exactly what it was.
    const agent = make();
    const running = agent.prompt("go");
    await new Promise<void>((r) => setTimeout(r, 10));
    agent.abort();
    expect((await running).reason).toBe("aborted");
    expect(summaries).toBe(1);
    expect(agent.messages.some((m) => m.content.includes(SUMMARY_HEADING))).toBe(false);
    expect(agent.messages.map((m) => m.id)).toEqual([...big.map((m) => m.id), agent.messages.at(-1)!.id]);

    // Without the abort the same history compacts, then answers.
    pauseMs = 0;
    const ok = make();
    await ok.prompt("go");
    expect(summaries).toBe(2);
    expect(ok.messages.filter((m) => m.content.includes(SUMMARY_HEADING))).toHaveLength(1);
    expect(ok.messages.at(-1)!.content).toBe("answer");
  });
});
