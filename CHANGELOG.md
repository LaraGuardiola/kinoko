# Changelog

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
