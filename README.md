# Kinoko

A small, fast, hackable coding-agent harness. Bun + TypeScript, **zero runtime dependencies**.

**Contents:** [Quick start](#quick-start) · [Modes](#modes) · [Keys](#interruption-is-the-feature) ·
[Config](#config) · [Tools](#the-six-tools) · [Sessions](#sessions-context-and-compaction) ·
[Extensions](#extensions) · [Skills](#skills) · [Profiles](#profiles) · [Background jobs](#background-jobs) ·
[Telegram & phone](#integrations) · [Development](#development)

## Quick start

Needs [Bun](https://bun.sh) and `git`.

```
git clone https://github.com/LaraGuardiola/kinoko && cd kinoko
bun run build
install -m 755 kinoko-out/kinoko ~/.local/bin/kinoko   # anywhere on PATH
mkdir -p ~/.kinoko
```

Pick a model. With no config, kinoko talks to OpenAI (`gpt-4o-mini`, its key from `$KINOKO_API_KEY`).

```
# Anthropic
echo '{ "provider": "anthropic", "model": "claude-opus-5-5" }' > ~/.kinoko/config.json
export ANTHROPIC_API_KEY=sk-ant-...

# or a local llama.cpp / Strata engine
cp examples/config.strata.json ~/.kinoko/config.json
```

```
kinoko                         # interactive
kinoko -p "fix the flaky test" # one shot: the answer on stdout
kinoko --mode rpc              # JSONL over stdio, for editors and scripts
```

From source, without building: `bun run start`.

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

## Modes

- **`kinoko`** (no arguments) — the interactive one. Raw ANSI, no alternate screen, so your terminal scrollback
  keeps the history and only a live region at the bottom is repainted (at ~30fps).
- **`-p "prompt"`** — non-interactive: the full agent loop, the final answer on stdout, tool
  activity on stderr, non-zero exit if the run was aborted or failed.
- **`--mode rpc`** — JSONL on stdin, JSONL on stdout. Commands: `prompt`, `steer`, `follow_up`,
  `abort`, `get_state`, `get_messages`, `approve` (`request`, `allow`, `remember?`: answers an
  `approval_request`). Out: the AgentEvent stream. `steer`/`follow_up`/`abort`/`approve` work mid-run.
- **`kinoko serve`** — the hub for the phone app ([kinoko-android](https://github.com/LaraGuardiola/kinoko-android)):
  runs agents (an rpc child each, in its project) and streams their events to paired devices over a
  WebSocket ([docs/protocol.md](docs/protocol.md)). It listens on localhost and shares itself with
  your tailnet through Tailscale (`--funnel`: with the internet; `--local`: not at all), taking the
  share down when it stops. Pair a device by scanning `kinoko serve pair`'s QR code; `kinoko serve
  devices` and `revoke <id>` manage them. A kinoko open in a terminal links itself to the hub too
  (a local socket): the phone follows it and talks to it, and the terminal shows what came from the
  phone as if typed there (`KINOKO_LINK=0` keeps a terminal out).

## Config

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

`"approvalTimeoutMs"` (default 600000, 10 min): a call an extension asks about (permission-gate's
`sudo`, `rm -rf`...) waits this long for an answer (y, n or a in the TUI, or from the phone), then
counts as denied.

```json
{ "baseUrl": "http://127.0.0.1:8081/v1", "apiKey": "any",
  "model": "qwen3.8-flash-next-coder-iq1_m-120k", "contextWindow": 122880,
  "reasoningEffort": "low", "maxOutputTokens": 8192, "label": "strata" }
```

`examples/config.strata.json` is exactly that, for a local Strata/llama.cpp engine.

Unknown keys, values of the wrong type and a file that is not valid JSON are skipped without a
warning: when a setting seems to do nothing, check its spelling and type first.

| key | default | what it does |
| --- | --- | --- |
| `provider` | `"openai-compat"` | `"openai-compat"` or `"anthropic"` |
| `baseUrl` | `https://api.openai.com/v1` | the engine's endpoint |
| `apiKey` | `$KINOKO_API_KEY` | (`$ANTHROPIC_API_KEY` for Anthropic) |
| `model` | `"gpt-4o-mini"` | |
| `contextWindow` | `128000` | compaction fires at `contextWindow - 16384` |
| `maxOutputTokens` | `8192` | |
| `reasoningEffort` | the engine's | `off` · `low` · `medium` · `high` |
| `thinkingBudget` | the engine's | hard cap on thinking tokens per reply |
| `thinkingReplay` | `"turn"` | `"turn"` or `"none"`, see above |
| `maxTurns` | `500` | tool rounds per run |
| `maxCost` | `5` | USD per run |
| `retries` | `3` | `0` never retries |
| `approvalTimeoutMs` | `600000` | an unanswered approval counts as denied |
| `label` | the endpoint's host | the provider's name in `/models` |
| `extensionsRepo` / `skillsRepo` | kinoko-extensions / kinoko-skills | where `/extensions` and `/skills` install from |

Anthropic: `"provider": "anthropic"` with a Console API key (`apiKey`, or `$ANTHROPIC_API_KEY`).
`baseUrl`, `contextWindow` and `maxOutputTokens` left at their defaults come from
`src/providers/models.json`; `reasoningEffort` maps to the model's effort.

```json
{ "provider": "anthropic", "model": "claude-opus-5-5", "reasoningEffort": "high" }
```

## The six tools

| tool | what it does |
| --- | --- |
| `read` | line-numbered reads with `offset`/`limit`, binary refusal |
| `write` | creates directories, refuses to overwrite something you have not read |
| `edit` | exact-substring edits, ambiguous matches refused, all-or-nothing |
| `bash` | runs in its own process group; abort kills the whole group |
| `search` | one tool for grep + glob + find: smart-case, .gitignore aware, token budgeted |
| `todo` | the model's plan: the whole list each call (pending, in progress, done), shown in the side panel |

`search` has two backends and no index: `rg` from `PATH` (install ripgrep for speed), or a pure-Bun
scan. kinoko never downloads anything on its own. `bun run scripts/probe-engine.ts` tells you what your local
engine can do.

## Sessions, context and compaction

Every message is appended to `~/.kinoko/sessions/<project-hash>/<id>.jsonl` as it is finalized,
including aborted ones. Sessions are kept per directory. When the TUI closes it prints
`kinoko --session <id>`: run that in the same directory to pick up where you left off (a unique
prefix of the id works too); the conversation is printed again and the model sees all of it.
`--continue` (or `-c`) takes the directory's newest session. A session nothing was said in is not kept.

`/sessions` lists this directory's sessions, the latest first, each with its first prompt and its
tokens; the first row adds them all up. Enter on one shows its numbers (tokens sent, generated and
cached, per reply, compactions, the tools it used and how they went); Enter again, one row per tool
(calls, OK, errors, failed commands, success rate). R on a past session resumes it right there.

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
  k.registerRenderer("hello", (source, width) => [`drawn: ${source}`.slice(0, width)]);
}
```

A tool may answer `{ text, images }` instead of a string: the images (`{ mime, data }`, base64) go to
the model with the result (Anthropic inside the tool_result; OpenAI-compatible engines, which take no
images there, in a user message right after the results).

`registerRenderer(lang, render)` draws a fence of that language (```` ```mermaid ````) in the
transcript: rows at most `width` wide, or undefined to show the source. It is called once the fence
is closed, its drawing kept while the reply streams; one that throws or draws too wide shows the source.

Events: `session_start`, `context` (rewrite the messages before a request), `before_provider_request`,
`tool_call` (mutate args, block, or `{ask: true, reason}` to ask the user first), `tool_result`, `turn_end`, `compact`, `run_end`. A handler that
throws is logged and skipped; a blocked call returns its reason to the model instead of running.

The extensions live in their own repository,
[kinoko-extensions](https://github.com/LaraGuardiola/kinoko-extensions): check-early, cliamp,
delegate, github, herdr, mermaid, notify, permission-gate, plan-mode, telegram, vision, web. `/` then **extensions** lists them (the repository is fetched with
git into `~/.kinoko/registry/extensions/`); Enter installs one into `~/.kinoko/ext/<name>/`, running
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

## Profiles

`/` then **profile** (or `/profile` from the phone) switches what is on in one go: which extensions and
skills (installed from the catalogs when missing, the rest switched off), how much the model thinks,
and whether it asks before gated commands. It takes effect at once, the [Capabilities] lines say
which profile is in use, and it stays chosen for the next kinoko.

| profile | for | thinking | asks |
| --- | --- | --- | --- |
| **Amanita Muscaria** | everything on (but plan-mode): goes all in | high | never (the hardline still blocks) |
| **Shiitake** | coding: check-early, github, delegate, mermaid, web, notify | medium | yes |
| **Psilocybe** | media and the desktop: vision, cliamp, telegram; ffmpeg, torrente, flux-send, omarchy, bluetooth | low | yes |
| **Morchella** | reviewing and planning: plan-mode (writes nothing), github, web, mermaid, vision | high | yes |
| **Cordyceps** | orchestrating other agents: delegate, telegram, notify, github, web | medium | yes |
| **Mycena** | a local model at its fastest: few tools, a short prompt | low | yes |

`~/.kinoko/profiles.json` changes them or adds your own: `{ "profiles": [{ "name": "enoki", "title":
"Enoki", "extensions": ["web"], "skills": [], "thinking": "low" }] }` (`"*"` is everything, minus
`"except"`; `"approvals": "auto"` asks nothing). Switching tools makes a local engine read the whole
prompt again once: switch at the start of a task.

## Background jobs

Ask for something long ("download this and then unpack it", "run the build and tell me how it
went") and the model can start it with `bash` and `background: true`: the command runs on its own,
in its own process group, and the model finishes its reply instead of waiting. When the job ends,
the agent gets a message with its exit code and last lines and carries on by itself (woken when
idle; mid-run, it hears it after its current step). With Telegram on, that run's end reaches your
phone too.

The rule above the input shows `⚙ 2 shells` while jobs run, left of the thinking level. Click it (or
`/jobs`) for the list; Enter opens a job's window, its last lines in a frame that follows the
output; Del twice stops a job. Esc never stops jobs (it stops the model); quitting kinoko does. All
output is kept in `~/.kinoko/jobs/`.

The `delegate` extension uses them for other coding agents: "ask opencode to write the tests, then
run them" starts opencode (or pi, Claude Code, Codex, another kinoko: whichever are installed) on
the task in the background; you watch it under ⚙ shells, and kinoko is woken with its answer.

## Your shell, inside kinoko

A line that starts with `!` runs in your own shell, right there: `!sudo pacman -Syu` asks for the
password as usual, and its output stays above when kinoko comes back below it. `/shell` opens an
interactive shell the same way, until `exit` (or Ctrl-D). Meanwhile the terminal is the shell's:
Ctrl-C stops the command, not kinoko. Not during a run (Esc it first). It is for you, not the model:
nothing typed there reaches the conversation.

## Integrations

`/` then **integrations** sets Telegram up step by step: create a bot with @BotFather, paste its
token (checked with Telegram at once), then pair your chat by sending the bot a one-use code. The
options switch the bot on or off, notifications when a run ends, prompts from the chat and approvals
there. It is all kept in `~/.kinoko/integrations.json` (mode 600); `kinoko serve` runs the bot.
Replies and prompts go through Telegram's servers.

In the chat: every run that ends is told with its reply (not the ones you stopped); reply to one of
those messages to prompt that agent (a steer if it is working); plain text goes to the agent selected
last. `/agents` picks one, `/new` starts one in a project, `/status`, `/stop`, `/compact`, `/models`.
An approval comes with ✅ Allow · ❌ Deny · ✅ This session, and the message says who answered.
Send the bot a file or a photo (a caption becomes the prompt): it is saved in `~/.kinoko/telegram/`
and the agent is told where; a photo also goes as an image. The other way, the `telegram` extension
gives the model a `telegram_send` tool for files you ask to get there.

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
column is erased before anything scrolls, so the scrollback keeps only the transcript. Whenever the
width changes (the window resized, the column coming or going), kinoko draws the screen again from
what it printed, each reply rewrapped and each tool's band refilled at the new width. One caveat of
keeping the terminal's own scrollback: rows the terminal re-wrapped into the scrollback before
kinoko heard of the resize stay as the terminal left them.

## Development

```
bun run check     # oxlint --deny-warnings && tsc --noEmit && bun test
bun run src/tui/demo.ts   # watch the region repaint while the editor stays live
```

`docs/PROGRESS.md` is the running log of what is done, what is deliberately not done, and why.
