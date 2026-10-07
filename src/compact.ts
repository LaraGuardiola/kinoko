// Compaction: the one operation allowed to change the prompt prefix.
//
// The head of the history is replaced by one compact summary written by the same model,
// the recent tail is kept verbatim (tool results must not be re-read by the model: they are
// already correct, and re-summarizing them invites drift). Aborting leaves history untouched.

import { estimateTokens } from "./tools/budget.ts";
import type { Message, Provider } from "./types.ts";

/** Compaction fires this far below the context window, so it stays a late trigger. */
export const RESERVE = 16_384;
/** Roughly how much of the recent history survives verbatim. */
export const TAIL_TOKENS = 20_000;
export const SUMMARY_HEADING = "<compacted_summary>";

const OVERFLOW_PATTERNS = [
  "context length",
  "context_length",
  "context window",
  "maximum context",
  "too many tokens",
  "prompt is too long",
  "reduce the length",
];

export interface CompactOptions {
  provider: Provider;
  model: string;
  system: string;
  signal: AbortSignal;
  tailTokens?: number;
}

export interface CompactResult {
  view: Message[]; // summary + verbatim tail, ready to send
  summary: Message;
  keepFrom: string; // id of the first kept message
}

export function isSummary(m: Message): boolean {
  return m.role === "user" && m.content.startsWith(SUMMARY_HEADING);
}

export function messageTokens(m: Message): number {
  return estimateTokens(`${m.role}\n${m.content}${m.toolCalls ? JSON.stringify(m.toolCalls) : ""}`);
}

export function historyTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

export function shouldCompact(messages: Message[], contextWindow: number): boolean {
  return messages.length > 0 && historyTokens(messages) > contextWindow - RESERVE;
}

/** True for the provider errors that mean "your prompt did not fit". */
export function isContextOverflow(message: string): boolean {
  const lower = message.toLowerCase();
  return OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Summarizes everything but the verbatim tail. Returns undefined when nothing was done, so
 * the caller keeps its history: aborted signal, or too little to compact.
 */
export async function compactHistory(
  messages: Message[],
  opts: CompactOptions,
): Promise<CompactResult | undefined> {
  if (opts.signal.aborted || messages.length === 0) return undefined;
  const tailTokens = opts.tailTokens ?? TAIL_TOKENS;
  const split = splitIndex(messages, tailTokens);
  if (split === undefined) return undefined;

  const previous = isSummary(messages[0]!) ? messages[0]! : undefined;
  const toSummarize = previous ? messages.slice(1, split) : messages.slice(0, split);
  if (toSummarize.length === 0) return undefined;

  const text = await summarize(toSummarize, previous, opts);
  if (text === undefined || opts.signal.aborted) return undefined;

  const tail = messages.slice(split);
  const summary: Message = {
    id: crypto.randomUUID(),
    role: "user",
    content: `${SUMMARY_HEADING}\n${text.trim()}\n</compacted_summary>`,
  };
  return { view: [summary, ...tail], summary, keepFrom: tail[0]!.id };
}

/** Newest messages back to `tailTokens`; never splits an assistant message from its tool results. */
function splitIndex(messages: Message[], tailTokens: number): number | undefined {
  if (messages.length < 2) return undefined;
  let used = 0;
  let index = messages.length;
  while (index > 0) {
    const next = used + messageTokens(messages[index - 1]!);
    // Always keep at least the newest message, however big it is on its own.
    if (index < messages.length && next > tailTokens) break;
    used = next;
    index--;
  }
  if (index <= 0) return undefined; // the whole history fits in the tail
  // A kept tail must not start with a tool result whose assistant call was summarized away.
  while (index < messages.length && messages[index]!.role === "tool") index++;
  return index < messages.length ? index : undefined;
}

async function summarize(
  toSummarize: Message[],
  previous: Message | undefined,
  opts: CompactOptions,
): Promise<string | undefined> {
  const ask: Message = { id: "compact", role: "user", content: summarizePrompt(toSummarize, previous) };
  const req = { model: opts.model, system: opts.system, messages: [ask], tools: [], signal: opts.signal };
  let out = "";
  for await (const ev of opts.provider.stream(req)) {
    if (opts.signal.aborted) return undefined;
    if (ev.type === "text") out += ev.delta;
    else if (ev.type === "error") return undefined;
    else if (ev.type === "done" && ev.stop === "aborted") return undefined;
  }
  return out === "" ? undefined : out;
}

function summarizePrompt(toSummarize: Message[], previous: Message | undefined): string {
  const parts = [
    "Compact the following coding-agent transcript into notes a colleague could pick up cold.",
    "Use exactly these sections, one line each, no preamble:",
    "Objective / Decisions / Work State / Next Step / Relevant Files.",
    "Keep file paths, commands and decisions verbatim. Drop chatter, and drop anything already done.",
  ];
  if (previous) {
    parts.push(
      "A previous summary is included below. Merge it: keep what is still true, drop what the transcript supersedes.",
      "<previous_summary>",
      previous.content,
      "</previous_summary>",
    );
  }
  parts.push("<transcript>", transcript(toSummarize), "</transcript>");
  return parts.join("\n");
}

/** Plain rendering of the transcript: same order, same bytes, every time. */
function transcript(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const calls = (m.toolCalls ?? []).map((c) => `  tool_call ${c.name} ${JSON.stringify(c.args ?? {})}`);
    out.push(`${m.role}: ${m.content}${calls.length ? `\n${calls.join("\n")}` : ""}`);
  }
  return out.join("\n");
}