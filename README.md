# Kinoko

A small, fast, hackable coding-agent harness. Bun + TypeScript, **zero runtime dependencies**.

```
bun run src/main.ts --tui          # interactive
bun run src/main.ts -p "fix the flaky test"
bun run src/main.ts --mode rpc     # JSONL over stdio, for editors and scripts
```

## What it is

A thin loop around a model plus six tools. That is the whole product:

- **`src/loop.ts`** is the agent: a linear loop with `abort`, `steer` and `followUp`.
- **`src/tools/`** are the six tools. Nothing else gets to touch the disk or a subprocess.
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
| `Alt+X` | — | send the waiting steer **now**: cuts the reply being written, thinking included |
| `Alt+C` | — | cancel the queued messages: they go back into the editor |
| `Ctrl-T` | expand or collapse tool output | same |
| `Ctrl-V` | paste the clipboard image as `[Image #N]` | same |
| `@` | reference a file: lists the directory as you type (Tab/Enter completes) | same |
| `Ctrl-P` / `Ctrl-N` | previous / next history entry | same |
| `Shift+Enter` / `Ctrl-J` | newline inside the editor | same |
| `Ctrl-O` | unfold the plan over the side column, scroll it with ↑↓ PgUp PgDn, Esc folds it (narrow window: prints it) | same |

`Alt+Enter` is told apart from `Shift+Enter` only by terminals with the kitty keyboard protocol;
elsewhere both send ESC+Enter, which kinoko reads as a newline (as Claude Code and pi do).

Queued messages are never lost: abort a run and they come back in the editor with an
`Interrupted` marker. `docs/interruption.md` is the contract.

Images: `Ctrl-V` reads the clipboard (`wl-paste` on Wayland, `xclip` on X11), and pasting or
dropping a PNG, JPEG, GIF or WebP file path attaches that file. Each shows in the input as
`[Image #N]`; on Enter, the images whose placeholders are still in the text go with the message
(up to 3.75 MB each). The model must take images: a text-only engine answers with an error.

## The six tools

| tool | what it does |
| --- | --- |
| `read` | line-numbered reads with `offset`/`limit`, binary refusal |
| `write` | creates directories, refuses to overwrite something you have not read |
| `edit` | exact-substring edits, ambiguous matches refused, all-or-nothing |
| `bash` | runs in its own process group; abort kills the whole group |
| `search` | one tool for grep + glob + find: smart-case, .gitignore aware, token budgeted |
| `todo` | the model's plan: the whole list each call (pending, in progress, done), shown in the side panel |

`search` has three backends and no index: `rg` from `PATH`, a pinned ripgrep downloaded once to
`~/.kinoko/bin`, or a pure-Bun fallback. `bun run scripts/probe-engine.ts` tells you what your local
engine can do.

## Sessions, context and compaction

Every message is appended to `~/.kinoko/sessions/<project-hash>/<id>.jsonl` as it is finalized,
including aborted ones. Sessions are kept per directory. When the TUI closes it prints
`kinoko --session <id>`: run that in the same directory to pick up where you left off (a unique
prefix of the id works too); the conversation is printed again and the model sees all of it.
`--continue` (or `-c`) takes the directory's newest session. A session nothing was said in is not kept.

Local engines reuse the prompt prefix between requests, and a change near the start costs a full
re-read (about a minute per 30k tokens). So history is append-only and byte-stable: the system
prompt and tool schemas never change mid-session, tool arguments serialize through one function,
and steer/follow-up messages only ever land at the end. Compaction is the one allowed prefix change
and it fires late (`contextWindow - 16384`): the last ~20k tokens stay verbatim and the head becomes
one summary written by the same model.

## Extensions

A `.ts` file, or a folder with an `index.ts` (and its own dependencies), in `~/.kinoko/ext/` or
`./.kinoko/ext/`:

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

The extensions live in their own repository,
[kinoko-extensions](https://github.com/LaraGuardiola/kinoko-extensions): check-early, herdr,
permission-gate, plan-mode, web. `/` then **extensions** lists them (the repository is fetched with
git into `~/.kinoko/registry/extensions/`); Enter installs or updates one into `~/.kinoko/ext/<name>/`, running
`bun install` there when it has dependencies; Del twice removes it. Both take effect at once: the
extension is loaded (or taken back) while kinoko runs. One that adds or removes tools changes every
request's opening bytes, so a local engine reads the whole prompt again once; the note says so.
`"extensionsRepo"` in the config points the page at another repository. `examples/ext/hello.ts` is
the smallest example. Offline, the page lists the last fetched copy and what is installed.

## Skills

A skill is a folder with a `SKILL.md` (frontmatter `name` and `description`). kinoko lists every
skill to the model at start, name and description only; the model reads the body when the task
matches. They are read from `./.agents/skills/`, `~/.agents/skills/` (shared with other agents) and
`~/.kinoko/skills/`; the first of a name wins.

None ship with kinoko. [kinoko-skills](https://github.com/LaraGuardiola/kinoko-skills) has them:
`/` then **skills** works like **extensions** (fetched into `~/.kinoko/registry/skills/`, installed
into `~/.kinoko/skills/<name>/`, Del twice removes). The page also lists the skills of the shared
`~/.agents/skills/`, marked `shared`: kinoko loads them but never installs into or removes from there.
A skill installed or removed is told to the model as a `[kinoko]` note before your next message: the
skills index in the system prompt stays as it was (so the engine keeps its cache), and the next
start lists it there.
`"skillsRepo"` points it at another repository.

## The side panel

On a window two thirds of the screen wide or more, the screen splits in two columns: the transcript
on the left, and on the right, from the screen's top row down to the input's rule, the model's
**plan** (the newest `todo` call: done, in progress, pending, with a progress bar) above the working
tree's **changes** (every file that differs from HEAD, new files included, with its added and removed
lines, read with git after each tool). The input and the status line keep the full width below both.
While the column is on, `todo` calls get no block in the transcript: the column is where the plan is.

Tile the window narrower and the column goes; widen it and it comes back. The window's share of the
screen comes from the terminal itself (XTWINOPS `14;2t` and `15t`: foot, xterm, kitty...; 140 columns
when it does not answer), and where the input sits on the screen from a cursor position request. The
column is erased before anything scrolls, so the scrollback keeps only the transcript. One caveat of
keeping the terminal's own scrollback: when the window gets narrower while the column is on, the
terminal re-wraps the screen before kinoko hears of it; kinoko redraws the screen, but rows the
re-wrap pushed into the scrollback keep pieces of the column.

## Config layers

Defaults → `~/.kinoko/config.json` → `./.kinoko/config.json` → CLI flags. Kebab-case or camelCase,
both work (`--max-turns` / `--maxTurns`).

`/models` lists the models grouped by provider (one per endpoint, in name order), each provider
asked for what it serves. `+ add provider` takes its name (strata, llama.cpp...), endpoint, API key,
then one of the models it serves; it is kept in `~/.kinoko/models.json` (mode 0600: it holds the
keys). Picking a model switches endpoint and model from the next request. Del twice on a saved model
removes it (the configured one stays). `"label"` names the configured provider in that list.

`"thinkingReplay"`: which of the model's old thinking goes back with each request. `"turn"` (the
default) sends the thinking of every step since your last message, so the model keeps its plan
between tool calls instead of re-reading your last message as if it were new; older thinking stays
out. `"none"` sends only a reply cut by the output limit, for models that copy old thinking verbatim.

`"retries"` (default 3): a dropped connection, no answer, or a 429/5xx is retried that many times in
a row, after 2s, 4s, 8s...; the partial reply is dropped and the note above the input says so. Esc
during the wait stops the run. `0` never retries.

```json
{ "baseUrl": "http://127.0.0.1:8081/v1", "apiKey": "any",
  "model": "qwen3.8-flash-next-coder-iq1_m-120k", "contextWindow": 122880,
  "reasoningEffort": "low", "maxOutputTokens": 8192, "label": "strata" }
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