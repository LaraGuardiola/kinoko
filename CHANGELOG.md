# Changelog

## Unreleased

Thinking levels that reach llama.cpp, each tool call on its own row, and LaTeX math.

### Thinking
- `/thinking` works with llama.cpp: `off` really turns thinking off (as `enable_thinking: false`;
  `"off"` still goes for Strata), each level sends its token budget to local engines (2,048 / 4,096 /
  8,192), and `extreme` is no cap at all (it used to end the thinking at once there). Cloud APIs get
  neither field.

### The TUI
- Several tool calls in one reply each get their own row: as the model writes them, then the
  waiting ones dim under the one running, instead of one line rewritten for every call.
- Math: `$$…$$` and `\[…\]` formulas are drawn centred as LaTeX sets them (fractions stacked, roots,
  sums with their limits, matrices), with a Math ⧉ label: a click or `/copy` copies the TeX. Inline
  `$…$` and `\(…\)` come out on one line (x², a/b, √x). Needs the `latex` extension; without it the
  text is as before. `\$` is a dollar sign.

### Extensions (installing one again from `/extensions` updates it)
- latex (new): TeX math drawn in Unicode, for the formulas above and ```` ```math ```` /
  ```` ```latex ```` fences. What it cannot read stays as source.

## 0.2.1

Fixes found using 0.2.0: shells left running, a screen that smeared, a todo list written to a file.

### Shells
- A command or background job that puts something aside with `&` or `nohup` now says so to the
  agent, with how to stop it; what a background job left running ends when kinoko quits.
- The todo tool says it is the todo list you see in the side panel: asked for a todo list, the
  agent no longer writes one to a file.

### The TUI
- A background job ending while the model writes no longer copies its text down the screen: a
  queued message of several lines takes one row, and so does a job's multi-line command in `/jobs`.
- A window made narrower (full screen to half) keeps a clean scrollback: kinoko prints it again at
  the new width instead of leaving the terminal's ragged re-wrap of every band.

### Extensions (installing one again from `/extensions` updates it)
- permission-gate: `rm -f /tmp/x` is no longer refused as if it were `rm -rf /`; only `/`, `~`,
  `$HOME` or `.` themselves are.
- cliamp: `music status` names the next song; a background job reads the song from
  `cliamp status`.

## 0.2.0

The first public release. kinoko runs on Linux, macOS and Windows, as one binary with nothing else
to install.

### The agent
- Six core tools (read, write, edit, bash, search, todo); everything else is an extension.
- Any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio, vLLM, hosted APIs) and Anthropic's.
  No configuration needed: a first run leads to `/models`, where a provider is added by its URL and
  the model picked from what it serves; it is kept for the next start.
- Interruption is first-class: Esc stops the model, a tool, a shell at once; steer while it works.
- Shells that run on their own (`bash` with `background: true`), shown as ⚙ in the TUI and stopped
  from `/jobs`; the agent is woken with their result.
- Sessions per directory: `kinoko -c` resumes the newest, `/sessions` lists them with their tokens,
  tools and how they went, and resumes one.
- Compaction when the context fills; approvals for gated commands, answered from the TUI, the phone
  or Telegram.

### The TUI
- Markdown, code, diffs, directory trees and tables drawn in the terminal; ```mermaid diagrams with
  the mermaid extension.
- A side column with the plan and the working tree's changes; `@` to reference a file; pasted or
  dropped images; a copy mark on every code block.
- `!command` and `/shell` hand the terminal to your shell and take it back.
- Profiles (Amanita, Shiitake, Psilocybe, Morchella, Cordyceps, Mycena): what is switched on, how
  much it thinks, what it asks; each with its own Kinoko.

### Extensions and skills
- Installed one by one from `/extensions` and `/skills`
  ([kinoko-extensions](https://github.com/LaraGuardiola/kinoko-extensions),
  [kinoko-skills](https://github.com/LaraGuardiola/kinoko-skills)), in effect without a restart.
- Web search that does not give up: your own SearXNG set up from `/searxng` (no key, no limit),
  Tavily or Exa keys, else search pages checked against the query.
- An extension or skill made for some systems only is marked, never installed or loaded elsewhere.

### kinoko serve and the phone
- `kinoko serve`: a hub for the Android app (pair with a QR from `kinoko serve pair`); agents and
  linked TUIs, their chats, approvals, files both ways, slash commands, background shells.
- Over Tailscale from anywhere, or on the local network encrypted with the hub's own certificate.
- A Telegram bot: runs ending, prompts, approvals, files.

### Windows
- Git Bash when it is there, PowerShell otherwise (the model is told which); CRLF files kept CRLF;
  the hub's link over a named pipe.
