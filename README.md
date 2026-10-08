# Kinoko

A small, fast, hackable coding-agent harness. Bun + TypeScript, **zero runtime dependencies**.

```
bun run src/main.ts --tui          # interactive
bun run src/main.ts -p "fix the flaky test"
bun run src/main.ts --mode rpc     # JSONL over stdio, for editors and scripts
```

## What it is

A thin loop around a model plus five tools. That is the whole product:

- **`src/loop.ts`** is the agent: a linear loop with `abort`, `steer` and `followUp`.
- **`src/tools/`** are the five tools. Nothing else gets to touch the disk or a subprocess.
- **Everything else is an extension** (`src/ext.ts`): policy, extra tools, slash commands.

Small core, so you can read it in an afternoon. Roughly 2000 lines of core code, no framework, no
TUI library, no agent SDK, no index, no embeddings, no MCP.

## Interruption is the feature

A local model on a 12 GB card takes *minutes* to read a long prompt. If you cannot cut it, steer it
and hand the queued text back when it stops, the harness is useless. So every async operation takes
an `AbortSignal`, nothing blocks the event loop, and the keyboard always wins:

| key | idle | running |
| --- | --- | --- |
| `Enter` | send as prompt | **steer** the running turn |
| `Alt+Enter` | send as prompt | **follow up** (delivered when the model would stop) |
| `Esc` | nothing | **abort** |
| `Ctrl-C` | clear the editor, then quit | abort |
| `Ctrl-D` | quit (empty editor) | — |
| `Alt+Up` | — | pull the newest queued message back into the editor |
| `Ctrl-T` | expand or collapse tool output | same |
| `Ctrl-P` / `Ctrl-N` | previous / next history entry | same |
| `Shift+Enter` / `Ctrl-J` / `Ctrl-O` | newline inside the editor | same |

`Alt+Enter` is told apart from `Shift+Enter` only by terminals with the kitty keyboard protocol;
elsewhere both send ESC+Enter, which kinoko reads as a newline (as Claude Code and pi do).

Queued messages are never lost: abort a run and they come back in the editor with an
`Interrupted` marker. `docs/interruption.md` is the contract.

## The five tools

| tool | what it does |
| --- | --- |
| `read` | line-numbered reads with `offset`/`limit`, binary refusal |
| `write` | creates directories, refuses to overwrite something you have not read |
| `edit` | exact-substring edits, ambiguous matches refused, all-or-nothing |
| `bash` | runs in its own process group; abort kills the whole group |
| `search` | one tool for grep + glob + find: smart-case, .gitignore aware, token budgeted |

`search` has three backends and no index: `rg` from `PATH`, a pinned ripgrep downloaded once to
`~/.kinoko/bin`, or a pure-Bun fallback. `bun run scripts/probe-engine.ts` tells you what your local
engine can do.

## Sessions, context and compaction

Every message is appended to `~/.kinoko/sessions/<project-hash>/<id>.jsonl` as it is finalized,
including aborted ones. Sessions are kept per directory. When the TUI closes it prints
`kinoko --session <id>`: run that in the same directory to pick up where you left off (a unique
prefix of the id works too); the conversation is printed again and the model sees all of it.
`--continue` takes the directory's newest session. A session nothing was said in is not kept.

Local engines reuse the prompt prefix between requests, and a change near the start costs a full
re-read (about a minute per 30k tokens). So history is append-only and byte-stable: the system
prompt and tool schemas never change mid-session, tool arguments serialize through one function,
and steer/follow-up messages only ever land at the end. Compaction is the one allowed prefix change
and it fires late (`contextWindow - 16384`): the last ~20k tokens stay verbatim and the head becomes
one summary written by the same model.

## Extensions

Drop a `.ts` file in `~/.kinoko/ext/` or `./.kinoko/ext/`:

```ts
import type { Kinoko } from "../../src/ext.ts";

export default function (k: Kinoko): void {
  k.on("tool_call", (call) => {
    if (call.name === "bash" && /rm\s+-rf/.test(call.args.cmd as string)) {
      return { block: true, reason: "no rm -rf from an agent" };
    }
  });
  k.registerTool({ name: "hello", description: "greet", schema: {}, run: async () => "hi" });
  k.registerCommand("hello", (args) => `hello, ${args}`);
}
```

Events: `session_start`, `context` (rewrite the messages before a request), `before_provider_request`,
`tool_call` (mutate args, or block), `tool_result`, `turn_end`, `compact`, `run_end`. A handler that
throws is logged and skipped; a blocked call returns its reason to the model instead of running.

`examples/ext/` ships four: `permission-gate.ts` (a hardline that `KINOKO_YOLO=1` can never open),
`plan-mode.ts` (read-only), `web.ts` (`web_search` and `web_fetch`: no API key, Brave, DuckDuckGo
then Bing, pages turned into readable text) and `hello.ts`.

## Config layers

Defaults → `~/.kinoko/config.json` → `./.kinoko/config.json` → CLI flags. Kebab-case or camelCase,
both work (`--max-turns` / `--maxTurns`).

Models added from the TUI (`/models` → `+ add model`: endpoint, API key, then one of the models it
serves) are kept in `~/.kinoko/models.json` (mode 0600: it holds the keys) and offered next to the
configured one; picking one switches endpoint and model from the next request. Del twice on a saved
model removes it (the configured one stays).

```json
{ "baseUrl": "http://127.0.0.1:8081/v1", "apiKey": "any",
  "model": "qwen3.8-flash-next-coder-iq1_m-120k", "contextWindow": 122880,
  "reasoningEffort": "low", "maxOutputTokens": 8192 }
```

`examples/config.strata.json` is exactly that, for a local Strata/llama.cpp engine. `apiKey` falls
back to `$KINOKO_API_KEY`. Unknown keys are dropped rather than silently ignored.

Anthropic: `"provider": "anthropic"` with a Console API key (`apiKey`, or `$ANTHROPIC_API_KEY`).
`baseUrl`, `contextWindow` and `maxOutputTokens` left at their defaults come from
`src/providers/models.json`; `reasoningEffort` maps to the model's effort.

```json
{ "provider": "anthropic", "model": "claude-opus-5-5", "reasoningEffort": "high" }
```

## Modes

- **`--tui`** — the interactive one. Raw ANSI, no alternate screen, so your terminal scrollback
  keeps the history and only a live region at the bottom is repainted (at ~30fps).
- **`-p "prompt"`** — non-interactive: the full agent loop, the final answer on stdout, tool
  activity on stderr, non-zero exit if the run was aborted or failed.
- **`--mode rpc`** — JSONL on stdin, JSONL on stdout. Commands: `prompt`, `steer`, `follow_up`,
  `abort`, `get_state`. Out: the AgentEvent stream. `steer`/`follow_up`/`abort` work mid-run.

## Install

```
bun run build
install -m 755 kinoko-out/kinoko ~/.local/bin/kinoko   # anywhere on PATH
cp examples/config.strata.json ~/.kinoko/config.json    # or write your own
```

Then just type `kinoko`. Bare `kinoko` opens the interactive mode, `-p` prints,
`--mode rpc` speaks JSONL. `bun run start -- --tui` runs it from source without
building.

## Development

```
bun run check     # oxlint --deny-warnings && tsc --noEmit && bun test
bun run src/tui/demo.ts   # watch the region repaint while the editor stays live
```

`docs/PROGRESS.md` is the running log of what is done, what is deliberately not done, and why.