# Changelog

## 0.4.0

Kinoko Lab, a live look inside the harness, and talking with kinoko: it hears you and answers out
loud.

### Kinoko Lab
- `kinoko serve` serves a page at `/lab`: one agent drawn as a small factory, live. Sixteen machines
  (the prompt press, the toolbox, the request, the model reading the prompt, the stream, the guards,
  the gate, the approval desk, the tools…) joined by belts, with the agent's work riding them as it
  happens, and a sentence that says what it is doing and why. Tap a machine for what it holds right
  now: the system prompt in its parts, the tools' schemas, the exact request as JSON, the history, the
  gate's decisions, the token and cache counts. ½× and ¼× slow it down to follow.
- `kinoko serve lab` prints a link for this computer and QR codes for a phone or tablet: one for the
  local network (no Tailscale needed; the browser warns once about the hub's own certificate, and
  the command prints its fingerprint to check), one through Tailscale. Each link pairs once, within
  ten minutes; the page says why when one was refused.
- A phone gets its own floor, two machines across.

### Talking with kinoko (the `voice` extension)
- Ctrl+Space turns voice mode on: say "kinoko, …" and it is your prompt; while it works, what you say
  goes in at once as a steer. It reads its replies aloud as it writes them, sentence by sentence, in a
  voice you can clone from a 10-second clip (Spanish from Spain too). Esc, or talking to it, stops it.
  `/voice wake off` for a quiet room: no name needed.
- Speech to text and text to speech are backends set in `~/.kinoko/voice.json`: whisper.cpp,
  Qwen3-TTS through qwentts.cpp, piper, or any OpenAI-compatible server. The extension's README has
  the setup, cloned voices and the echo cancelling speakers need. Install it from `/extensions`.
- `music-watch` is gone from kinoko-extensions.

### The TUI
- Alt+X (send the steer now) also stops the tools running: the command is killed, the calls after it
  do not run, and your message goes in at once. Before, a steer waited for the tools to finish.

### For extensions
- They hear every event the agent tells (`agent_event`: the reply as it streams) and the user asking
  for quiet (`interrupt`: Esc or Ctrl-C, a run going or not).
- They can take Ctrl+Space (`registerKey`, listed in /help), send text as the user (`send`, as Enter
  or as Alt+X) and say what they are doing on the rule above the input (`status`).

### For the phone and the hub
- The agent tells more of what it does (the request's size, the model reading the prompt, the
  gate's word on each call, what joins the history, the guards), and `inspect` gives the last request
  as sent, the system prompt or the tools (docs/protocol.md).

## 0.3.0

A kinoko that remembers what you sent, tells you when the model you configured is not the one
answering, lets the phone stop a shell, and a TUI whose code reads like prose.

### The TUI
- The messages you sent are kept across runs, as a shell keeps its history: ↑ in a new kinoko
  brings back what you sent in the last one (`~/.kinoko/history.jsonl`, the newest 200, 0600).
- At start, a model your endpoint does not serve is told, with what it does serve and how to make
  that the default (`D` in `/models`). A local engine answers any name with the model it has
  loaded, so a config naming another file used to go unnoticed.

### The phone
- A running shell's window has Stop: two taps end it, and everything it started (`/jobs stop #N`
  for any client). The app needs its main build for the button.

### Inside
- `src/tui/app.ts` (1,770 lines, one class doing ten jobs) is now its parts, each in a file named
  for what it does: the scrollback, the run's view, where what you type goes, the slash menu and
  its pages and commands, the model switch, the extensions menu, sessions, the startup panel, the
  thinking level, the note above the editor. `app.ts` wires them together; its header lists them.
  Nothing you see changed.

## 0.2.3

The messages you sent back with the arrows, a default model chosen from the menu, and the phone
keeping up with the model in use.

### The TUI
- ↑ and ↓ walk the messages you sent, as in a shell: from the start of the text (or its end), ↑
  brings the previous one and ↓ the next, and past the newest the draft you were typing comes back.
  In the middle of the text the first ↑ goes to its start; in a message of several lines the arrows
  still move between lines. Ctrl-P / Ctrl-N as before.
- `/models`: D makes the selected model the default, the one new sessions and the phone's new agents
  start with. It is written into `~/.kinoko/config.json` (made 0600: it holds the key); the model it
  replaces stays in the list. The default is marked.
- A model whose endpoint does not say its context window gets the default one (128k), not the window
  of the model used before it.
- Picking a model or a thinking level is told in cream, like the other notes, not on a white band.

### The phone
- The agents list says the model in use: a switch from the app, the TUI or Telegram reaches it at
  once (it showed the model the agent started with).
- The app (kinoko-android, main) draws LaTeX math like the TUI: `$$…$$` blocks centred with their
  Math ⧉ label, inline `$…$` in the text. It needs the `latex` extension on the computer.

## 0.2.2

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
