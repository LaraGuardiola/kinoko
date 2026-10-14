// Every sentence Kinoko Lab shows, in one place: the machines' names and why they exist, and how
// each moment of a run is told. English only for now; another language is another copy of this.

import type { MachineId } from "./machines.ts";

/** Each machine: its name, a few words that say what it is at a glance, and why it exists. */
export const MACHINE_WORDS: Record<MachineId, { name: string; tag: string; why: string }> = {
  inbox: {
    name: "Inbox",
    tag: "what you type",
    why: "What you type. A prompt starts a run; a steer goes in at the next step; a follow-up when the run would stop.",
  },
  history: {
    name: "History",
    tag: "the model's memory",
    why: "The conversation so far. Every request carries all of it: it is the model's only memory.",
  },
  compactor: {
    name: "Compactor",
    tag: "when it won't fit",
    why: "When the history would not fit the model's window, its old part becomes a summary and the recent part stays.",
  },
  context: {
    name: "Context filter",
    tag: "extensions rewrite it",
    why: "Extensions may rewrite the history right before it is sent: trim it, or add to it.",
  },
  press: {
    name: "Prompt press",
    tag: "the system prompt",
    why: "The system prompt: who the model is, the tools' names, the date and folder, AGENTS.md, the skills. Byte-stable, so the engine's cache survives.",
  },
  toolbox: {
    name: "Toolbox",
    tag: "what it can call",
    why: "The tools' schemas, sent with every request. The model can only act through these: it writes a call, kinoko runs it.",
  },
  request: {
    name: "Request",
    tag: "one per step",
    why: "One request per step: the system prompt, the tools and the whole history, sent to the model's endpoint.",
  },
  prefill: {
    name: "Prefill",
    tag: "the model reads it all",
    why: "Before it says a word the engine reads every token of the request. A cache lets it skip what it read last time.",
  },
  stream: {
    name: "Stream",
    tag: "the reply, token by token",
    why: "The reply arriving token by token: thinking, text, tool calls. A call is only real when its JSON is complete.",
  },
  guards: {
    name: "Guards",
    tag: "loops, stalls, cut-offs",
    why: "Small models loop, stall or get cut off. The harness notices, cuts the reply and nudges the model.",
  },
  dispatcher: {
    name: "Dispatcher",
    tag: "calls, in order",
    why: "Takes the reply's tool calls and runs them one at a time, in the order written: a read after a write sees the write.",
  },
  gate: {
    name: "Gate",
    tag: "extensions decide",
    why: "Policy lives in extensions: each call is shown to them first. They may let it pass, rewrite it, block it, or ask you.",
  },
  approval: {
    name: "Approval desk",
    tag: "you decide",
    why: "A call an extension asked about waits here for your answer (terminal, phone or Telegram: the first one wins). Esc still cuts it.",
  },
  workbench: {
    name: "Workbench",
    tag: "the tools run here",
    why: "The tool running: kinoko acting on your machine. Its output goes back into the history; an error is just a message.",
  },
  jobs: {
    name: "Shell yard",
    tag: "shells that outlive the run",
    why: "Shells started in the background. They are not part of the run: they outlive it and tell the model when they end.",
  },
  exit: {
    name: "Exit",
    tag: "why it stopped",
    why: "Where a run ends, and why: done, aborted by you, a limit, or an error.",
  },
};

const n = (x: number): string => x.toLocaleString("en-US");
/** 1234 → "1.2k": short enough for a tile. */
export const short = (x: number): string => (x < 1000 ? String(x) : x < 100_000 ? `${(x / 1000).toFixed(1)}k` : `${Math.round(x / 1000)}k`);
const quote = (text: string, max = 80): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > max ? `${line.slice(0, max - 1)}…` : line}”`;
};
const plural = (count: number, one: string, many = `${one}s`): string => `${n(count)} ${count === 1 ? one : many}`;

/** How each moment of a run is told under the board. */
export const SAY = {
  idle: "Idle. Send kinoko a prompt and watch it work.",
  noAgent: "No agent here yet. Start kinoko in a terminal, or an agent from the phone.",
  runStart: (prompt: string) => `You asked: ${quote(prompt)}. It joins the history, which is what the model will read.`,
  request: (turn: number, tools: number, messages: number, tokens: number) =>
    `Request #${turn} leaves: the system prompt, ${plural(tools, "tool schema")} and ${plural(messages, "message")}, about ${n(tokens)} tokens. The model reads all of it, every time.`,
  prefill: (done: number, total: number) => `The engine is reading the prompt: ${n(done)} of ${n(total)} tokens (${Math.round((done / Math.max(total, 1)) * 100)}%). Nothing can be said before that.`,
  firstToken: "The model starts answering.",
  thinking: "The model is thinking: it writes for itself first.",
  writing: "The model is writing its reply.",
  pending: (name: string) => `The model is writing a call to ${name}. It only becomes real when its JSON is complete.`,
  replyCalls: (names: string[]) => `The reply asks for ${plural(names.length, "tool call")}: ${names.join(", ")}. They run one at a time, in order.`,
  replyNoCalls: "The reply has no tool calls: unless something is queued, the run ends here.",
  dispatch: (name: string) => `Dispatching ${name}: the extensions get their say first.`,
  pass: (name: string, by?: string) => (by ? `${by} lets ${name} through.` : `The gate lets ${name} through: no extension objected.`),
  rewritten: (name: string) => `An extension rewrote ${name}'s arguments before it runs.`,
  block: (name: string, reason: string, by?: string) => `${by ?? "An extension"} blocked ${name}: ${quote(reason)}. The model is told so, instead of a result.`,
  ask: (name: string, reason: string, by?: string) => `${by ?? "An extension"} asks you before ${name} runs: ${quote(reason)}. The loop waits; Esc still cuts it.`,
  skipped: (name: string, why: "auto" | "remembered") =>
    why === "auto" ? `The profile in use allows everything: ${name} runs without asking.` : `You allowed this call for the session: ${name} runs without asking.`,
  allowed: (by: string) => `Allowed (${by}). The call runs.`,
  denied: (by: string) => (by === "timeout" ? "Nobody answered: the call is denied, the model is told." : by === "abort" ? "The run was cut while the call waited." : `Denied (${by}): the model is told it did not run.`),
  output: (name: string, chars: number) => `${name} answered (${plural(chars, "character")}). The result goes back into the history.`,
  failed: (name: string, error: string) => `${name} failed: ${quote(error)}. A tool error is just a message: the loop goes on.`,
  guard: (detail: string) => `A guard noticed: ${detail}.`,
  nudge: (text: string) => `The harness nudges the model: ${quote(text, 100)}`,
  note: (text: string) => `The harness tells the model: ${quote(text, 100)}`,
  compacting: (done: number, total?: number) => `The history no longer fits: its old part is being summarised${total ? ` (${done}/${total})` : ""}.`,
  compacted: (keep: number) => (keep < 0 ? "Nothing to compact." : `Compacted: the old messages became one summary; ${plural(keep, "recent message")} stay as they were.`),
  retry: (attempt: number, of: number, inMs: number, error: string) => `The request failed (${quote(error, 60)}): trying again in ${Math.round(inMs / 1000)}s (${attempt}/${of}).`,
  queued: (steer: number, followUp: number) => `Waiting to be said: ${plural(steer, "steer")}, ${plural(followUp, "follow-up")}.`,
  delivered: (text: string) => `Your message reaches the model now: ${quote(text)}`,
  jobs: (running: number) => (running === 0 ? "No shells left running in the background." : `${plural(running, "shell")} running in the background: they outlive the run.`),
  model: (model: string) => `Model switched to ${model}, from the next request on.`,
  end: (reason: string, detail?: string) =>
    reason === "done"
      ? "Done: the model replied without tool calls and nothing was queued."
      : reason === "aborted"
        ? "Aborted: you cut it. What it had written is kept."
        : reason === "limit"
          ? `Stopped by a limit: ${detail ?? "a limit"}.`
          : `Stopped by an error: ${detail ?? "unknown"}.`,
};

/** What each tile says about itself, in a few words. */
export const TILE = {
  idle: "idle",
  waitingForYou: "waiting for you",
  queued: (steer: number, followUp: number) => [steer ? `${steer} steer` : "", followUp ? `${followUp} follow-up` : ""].filter(Boolean).join(" · "),
  messages: (count: number) => plural(count, "message"),
  filtered: (from: number, to: number) => (from === to ? `${n(to)} sent as they are` : `${n(from)} → ${n(to)} messages`),
  sentWith: (turn: number) => `sent with #${turn}`,
  tools: (count: number) => plural(count, "tool"),
  request: (turn: number, tokens: number) => `#${turn} · ~${short(tokens)} tokens`,
  reading: (done: number, total: number) => `${short(done)} / ${short(total)} read`,
  read: (total: number, cached: number) => (cached > 0 ? `${short(total)} · ${Math.round((cached / Math.max(total, 1)) * 100)}% cached` : `${short(total)} read`),
  thinking: (chars: number) => `thinking · ${short(chars)} chars`,
  writing: (chars: number) => `writing · ${short(chars)} chars`,
  wrote: (chars: number) => `replied · ${short(chars)} chars`,
  thought: (chars: number) => `thought · ${short(chars)} chars`,
  writingCall: (name: string) => `writing a call: ${name}`,
  quiet: "all quiet",
  calls: (count: number) => (count === 0 ? "no calls" : plural(count, "call")),
  running: (name: string) => `${name} · running`,
  answered: (name: string, chars: number) => (chars === 0 ? `${name} · no output` : `${name} · ${short(chars)} chars`),
  failed: (name: string) => `${name} · failed`,
  decision: (decision: string, name: string) => `${decision} · ${name}`,
  summarising: (done: number, total?: number) => (total ? `summarising ${done}/${total}` : "summarising"),
  shells: (count: number) => (count === 0 ? "none" : plural(count, "shell")),
  retrying: (attempt: number, of: number) => `retrying ${attempt}/${of}`,
};
