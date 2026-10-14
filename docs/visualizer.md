# Kinoko Lab: the flow visualizer (design)

A live, interactive diagram of what kinoko is doing, in the browser: a small factory where the
prompt is built, sent, streamed back, split into tool calls, gated, run, and fed back in. It is
for the owner and for anyone who wants to understand what a harness is. Every machine answers two
questions: **what is it doing right now**, and **why**. Clicking one shows its contents at that
moment. Stretch goal: **breakpoints and stepping**.

Its name is **Kinoko Lab**. Reviewed with the owner on 2026-10-14; the decisions they took are at
the end. Nothing is built yet: section 7 is the order of work.

## 1. The machines

One machine per thing the harness does, in the order a run touches them. The names are the ones
the page shows; the source is where a curious reader goes next.

| Machine | What it does | Why (the one line the page shows) | Source |
|---|---|---|---|
| **Prompt press** | Builds the system prompt: persona, tool names, date/model/cwd, AGENTS.md files, skills | "The model knows nothing about you; this is everything it is told up front, byte-stable so the engine's cache survives." | prompt.ts, context.ts |
| **Toolbox** | The tool schemas sent with every request (core six + extensions') | "The model can only act through these. It writes a call; kinoko runs it." | tools/, ext.ts |
| **History** | The conversation: user, assistant, tool messages, notes, nudges | "Each request carries all of it. This is the model's only memory." | session.ts, loop.ts |
| **Context filter** | Extensions rewriting the history before sending (`context` hook) | "Extensions may trim or add to what the model sees." | ext.ts |
| **Compactor** | Summarises the head of the history when it would not fit | "The window is full: the old part becomes a summary, the recent part stays." | compact.ts |
| **Request** | The provider request leaving: size, model, effort | "One request per step. The model reads it all, every time." | loop.ts, providers/ |
| **Prefill** | The engine reading the prompt (llama.cpp's progress) | "Before it says a word the model reads every token. This is why long chats are slow." | providers/ |
| **Stream** | Thinking, text and tool calls arriving token by token | "The model writes; kinoko listens. A call is only real when its JSON is complete." | loop.ts |
| **Guards** | Repeat/empty/cut-off detection, the nudges, turn and cost limits | "Small models loop. The harness notices and says so." | guard.ts |
| **Dispatcher** | Splits the reply into calls, in order; unknown tools become errors | "Calls run one at a time, in the order written: a read after a write sees the write." | loop.ts |
| **Gate** | Extensions' `tool_call` decision: pass, rewrite, block, or ask | "Policy lives in extensions. permission-gate asks before `rm -rf`." | ext.ts, approvals.ts |
| **Approval desk** | A call waiting for the user (TUI, phone, Telegram; first answer wins) | "The loop waits here, but Esc still cuts it." | approvals.ts |
| **Workbench** | The tool running (read, write, edit, bash, search, todo, extensions') | "This is kinoko acting on your machine." | tools/ |
| **Shell yard** | Shells left running (`bash background: true`), their own lane | "Not part of the run: they outlive it and tell the model when they end." | jobs.ts |
| **Return belt** | Results going back into the history (`ERROR: …` is a failed one) | "A tool error is just a message. The loop never crashes on one." | loop.ts |
| **Queue** | Steers and follow-ups waiting | "What you typed mid-run. A steer goes in at the next step, a follow-up when it would stop." | loop.ts |
| **Exit** | The run's end and its reason: done, aborted, limit, error | "Why it stopped." | loop.ts |

The loop is visible as a loop: Request → Stream → Dispatcher → Gate → Workbench → Return belt →
History → Request again. A run that ends without tool calls leaves through Exit.

## 2. The events

The hub already streams every `AgentEvent` (docs/protocol.md) to attached clients, and most
machines can be driven by them today: `request_start`, `first_token`, the deltas, `tool_pending`,
`tool_start/output/end`, `message_end`, `queue_change`, `delivered`, `compacting/compacted`,
`retry`, `jobs`, `approval_*`, `run_end`.

What is missing (the harness does it, but nobody hears of it):

| New event | Fields | Feeds |
|---|---|---|
| `request_start` (grown) | `model`, `messages`, `tools`, `chars`, `tokens` (an estimate) | Request: its size |
| `prefill` | `done`, `total` (tokens; the provider's `progress` events, throttled to ~4/s) | Prefill |
| `gate` | `call`, `decision: "pass" \| "block" \| "ask"`, `by?`, `reason?`, `rewritten?`, `skipped?` | Gate |
| `appended` | `role`, `kind: "prompt" \| "note" \| "nudge" \| "result" \| "reply" \| "steer"`, `chars` | History, Guards (a nudge is the guard's voice) |
| `guard` | `what: "repeat" \| "empty" \| "length" \| "same_call" \| "same_error"`, `detail` | Guards |

(Built in feat/lab-events: request_start grew instead of a new `request` event; `run_start` now
comes before the run's first `appended`.) All are small (no message bodies, no request JSON), emitted at points the loop already passes, and
cost a JSON line each. They go to every client like any event; old clients ignore unknown types
(the protocol already says so). No on/off switch is needed at that size.

**Contents are fetched, not streamed.** The full request (system prompt + history + tool schemas)
can be hundreds of KB per step; sending it on every request would cost the phone and the hub for a
feature most clients do not draw. Instead a client asks:

```
→ {"type": "inspect", "agent", "what": "request" | "system" | "tools"}
← {"type": "inspected", "agent", "what", "data"}   // the last request as sent, the system prompt, the schemas
```

The agent keeps a reference to its last `ProviderRequest` (it exists anyway). The history itself
the page already has (`attach` gives it, events extend it). With a breakpoint set, "the last
request" is exactly the one about to leave, so the inspection is precise where it matters.

## 3. Where it lives

**Recommended: a page served by `kinoko serve`, speaking the hub's protocol like the phone app.**

- The hub already has what the page needs: every agent (TUIs linked to it and the phone's), their
  events, the history replay on `attach`, auth, and a URL the phone reaches over Tailscale.
- The page is a client, not policy: it decides nothing and runs nothing. It is one static file
  (`src/serve/lab/`: hand-written HTML, SVG and JS, no framework, no build step), embedded in
  the binary and served at `GET /lab`.
- Auth: the browser needs a token like any device. `kinoko serve lab` prints a link with a
  one-time pairing code in its fragment (`http://127.0.0.1:7878/lab#c=…`); the page pairs itself
  as a device named "Kinoko Lab (browser)" and keeps the token in `localStorage`. On the phone, the same
  over the tailnet URL.

Why not an extension: an extension lives inside one agent process, so it would see one agent, each
agent would open its own port, and it could not reach the phone without reinventing the hub. Its
data (the events) already flows through the hub.

**Replay for the world.** The same page can play a recorded run with no hub at all: a JSONL of the
events (and the inspected contents), dropped on the page or loaded from a URL. That is what can be
put on a website or shared on X: a real kinoko run, explorable, step by step. `kinoko serve` would
record nothing by default; the page itself can save what it saw ("Save this run").

## 4. Clicking a machine

A side drawer (a bottom sheet on the phone) with what that machine holds at that moment:

- Prompt press: the system prompt, each block labelled (persona, tools line, AGENTS.md files,
  skills), with its size in characters and an estimate in tokens.
- Toolbox: each tool's name, description and JSON schema; which extension brought it.
- History: the messages, newest last, each with role and size; compacted ones folded into the
  summary that replaced them.
- Request: the exact request JSON (`inspect request`), collapsible.
- Stream: the reply as it is written; a tool call's arguments filling in.
- Gate / Approval desk: the call, the decision, who decided and why.
- Workbench: the call's arguments and its output (or the ERROR).
- Exit: the reason and its detail.

Each drawer opens with the machine's one-line "why" and links to its source file on GitHub.

## 5. Breakpoints and stepping (stretch)

The loop already knows how to wait for a client without hurting interruption: approvals. A
breakpoint is the same thing at a phase boundary.

- Phases: `before_request`, `after_reply`, `before_tool`, `after_tool`. (Compaction and the
  stream's middle are not breakable: one is a sub-run, the other a network read.)
- `Agent.setBreakpoints(phases)` and `Agent.resume(mode: "continue" | "step")`. With none set the
  loop checks a set's size and moves on: no await, no cost.
- When one hits, the loop emits `paused {phase, detail}` and awaits a promise that races the run's
  AbortSignal: **Esc still aborts a paused run**, exactly like a pending approval. `step` resumes
  and pauses at the next phase of any kind; `continue` resumes to the next breakpoint.
- Protocol: `→ {"type": "breakpoints", "agent", "phases": [...]}`, `→ {"type": "resume", "agent",
  "mode"}`, `← event paused`. Only the Lab sets and resumes them: the TUI and the app are not
  changed (a paused agent looks like one still working; Esc still aborts it).
- Breakpoints belong to the agent, not to the page: closing the page clears the ones it set, so an
  agent is never left paused with nobody watching (and the 10-minute approval timeout applies).

This is the one part that touches the loop's heart. It is a separate branch after the viewer
works, with tests for: abort while paused, step through a whole run, no cost when unset.

## 6. The look

- **A Factorio-like board**: machines as tiles on a dark grid, belts between them; each message,
  call or result is an item travelling on a belt, coloured by kind (user cream, assistant amanita
  red, tool calls the TUI's tool yellow, results green, errors a soft red). A machine glows while
  it works and shows a tiny progress bar (prefill tokens, compaction steps, tool time).
- Palette from the TUI (src/tui/style.ts, panel.ts): a dark background (to choose), cream `rgb(238,222,186)`, amanita
  `rgb(232,36,36)`, tool yellow (ANSI 221), green `rgb(158,206,106)`, soft red `rgb(240,113,120)`.
  The profile's mushroom (pixel art from `mushroom-art.ts`) as the page's mascot.
- Hand-written SVG for the board (crisp at any zoom, each machine a clickable group), CSS for the
  motion, `requestAnimationFrame` only for items on belts. No canvas unless SVG proves too slow.
- **On the phone**: the board turns into a vertical line (the loop drawn top to bottom, belts
  between), the drawer a bottom sheet. Readable without zooming.
- Speed control: live, or slowed down (×0.25) so a reader can follow; in replay also pause and
  scrub along a timeline.
- A plain-language caption under the board says what is happening now: "The model is reading
  14,210 tokens of prompt (62%)…", "permission-gate asked you about `rm -rf build`".

## 7. Order of work (each its own branch, each tested and shown before the next)

Built so far: 1 (feat/lab-events) and 2 (feat/lab-page). Two things came out differently from the
plan above: the phone does not get the wide floor turned into a single line but a floor of its own,
two machines across (src/serve/lab/machines.ts `PHONE_FLOOR`, the same belts laid), and the
Background yard is called the Shell yard. Each tile also carries a few words that say what it is
("the model's memory", "one per step").

1. **Events**: the five new events in loop.ts, `inspect` in rpc.ts and the hub, protocol.md. Tests.
2. **The page, live**: `/lab`, pairing by link, the board, the machines driven by events, the
   drawers. Checked by eye on a test hub (desktop and phone width).
3. ~~**Replay**: save a run, load one, the timeline.~~ Dropped: the owner does not miss it.
4. **Breakpoints**: the loop's pause, the protocol (from the page only). An idea, not planned.

## Prior art

LangSmith, Langfuse and OpenAI's agent tracing show traces after the fact as trees and timelines.
None draws the harness itself as a live machine, none lets you pause it, and none is made to teach.

## Decisions (the owner, 2026-10-14)

1. **In the hub**: the page is served by `kinoko serve` at `/lab`.
2. **Name**: Kinoko Lab.
3. **Live first**; replay after.
4. **English only** (an i18n layer may come later as its own feature: keep the page's strings in
   one table so it is easy).
5. **Breakpoints from the page only**: the TUI is not touched. The Lab is an extra, not core UX.
