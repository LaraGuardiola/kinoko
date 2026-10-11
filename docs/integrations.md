# Integrations: the plan (Telegram first)

A handover for a fresh context. Nothing here is built yet. Read this file, `AGENTS.md`, the last
entries of `docs/PROGRESS.md` and `docs/protocol.md`, then start with step 1 below. The user writes
in Spanish; answer in Spanish.

## What the user wants

- Talk to kinoko's agents from **Telegram**: be told when a run ends, answer it, start work,
  stop it. Later Discord, Gmail and GitHub follow the same path; build nothing for them now.
- **Approvals**: when the agent wants to run something gated (`sudo`, `rm -rf`...), ask the user
  wherever they are (the TUI, the phone app, Telegram) and wait, instead of denying outright.
- Set up **from the TUI's menu, step by step**: an `integrations` page, Telegram's setup as a
  guided flow (token, pairing, options), no file editing by hand.
- The same polish as the rest: zero runtime dependencies, AbortSignal everywhere, small files,
  tested with fakes.

## What exists today (facts, with where)

- **The hub**: `kinoko serve` (`src/serve/`) on 127.0.0.1:7878, reached through Tailscale.
  - It runs agents as `kinoko --mode rpc` children (`agents.ts`). Terminal TUIs link to it through
    `~/.kinoko/serve.sock` (`link.ts`).
  - It relays agent events to paired devices over a WebSocket (`server.ts`, protocol in
    `docs/protocol.md`).
  - Each agent's `AgentInfo` carries `state`, `ended` (`done | aborted | error | limit`) and `last`
    (the start of the last reply). That is everything a "run finished" message needs, and the
    phone's notifications use it already.
- **Devices** (`devices.ts`): one-use pairing codes, sha256 token hashes in `~/.kinoko/serve.json`.
  Reuse this shape for pairing a Telegram chat.
- **Slash commands for clients without the menu** (`src/commands.ts`): `runCommand(host, name,
  arg)`. The phone uses it through rpc `get_commands`/`command`. A Telegram `/compact` can go
  through the same function.
- **The TUI menu** (`src/tui/menu.ts`, `menu-pages.ts`, `app.ts` `#openRoot`): `ROOT` lists the
  commands, and a pick opens a page.
  - `ListPage`: items with `current`/`off` marks, `pick`, `stay`, `hint`.
  - `InfoPage`: lines to read.
  - `InputPage`: one line to type; `secret: true` shows dots, which suits an API token.
  - The mouse works in the menu (click, hover, wheel). Pages can be swapped while open
    (`menu.refresh(from, to)`), which is how a list finishes loading. A setup "wizard" is a chain of
    these pages.
- **Extensions** (`src/ext.ts`, repo `~/Projects/kinoko-extensions`, its own AGENTS.md).
  - `tool_call` handlers are **synchronous** and return `{block: true, reason}` or nothing
    (`Extensions.beforeTool`). There is no way to *wait for the user*.
  - `permission-gate` (in kinoko-extensions) denies gated commands unless `KINOKO_YOLO=1`, and
    always denies its hardline.
  - `api.ts` in that repo mirrors `src/ext.ts`/`src/types.ts`: change it with them.
- **Notifications today**: the `notify` extension (desktop notification, ntfy with `KINOKO_NTFY`)
  and the Android app's own notifications (`Notifier.kt`, from `AgentInfo.ended`).
- **Android app** (`~/Projects/kinoko-android`, Kotlin/Compose): a hub client (`HubCore`,
  `data/Protocol.kt`, `ui/ChatScreen.kt`). It ignores event types it does not know, so new
  protocol events do not break old builds.

## Decisions (take them unless the user says otherwise)

1. **Telegram lives in the hub, not in an extension.**
   - A bot has one update stream (`getUpdates` takes one consumer). Two kinoko processes polling
     the same bot steal each other's messages, and an extension is loaded once per agent.
   - The hub already sees every agent (app-started and terminal), keeps their state, and runs while
     the computer is on.
   - Telegram is "one more device": the bridge talks to the hub's agents the way `server.ts` does
     for a WebSocket.
2. **Long polling, no webhook.**
   - `getUpdates?timeout=50` with `fetch` and the hub's AbortSignal. No public URL, no Funnel
     needed, works behind NAT.
   - Plain `fetch` to `https://api.telegram.org/bot<token>/<method>`: no SDK (hard rule).
3. **Approvals are a core feature first, Telegram second.** The TUI, the phone and Telegram are
   three answerers of the same request. Build the core mechanism and the TUI prompt before any bot.
4. **One private chat, paired, an allowlist of one.** No groups at first. A paired chat id is the
   only one obeyed; anything else gets no answer (log it once).
5. **HTML parse mode** for messages (escape `& < >`, code in `<pre>`), not MarkdownV2: its escaping
   rules are a minefield. Messages are capped at 4096 characters: cut long replies with a
   "… (full reply in kinoko)" tail.
6. **No token streaming to Telegram.**
   - Send the reply when the run ends.
   - At most, one "working…" message edited every ≥3 s while it runs (Telegram rate-limits about
     one message a second per chat).

## Approvals: the core design

The wire and the loop:

- **The hook.** A `tool_call` handler may return `{ ask: true, reason }` besides `{ block: true,
  reason }`. Handlers stay synchronous; the *loop* does the waiting.
- **The loop** (`src/loop.ts`, where tool calls are validated before running), on an ask:
  - emits `approval_request { id, call: {id, name, args}, reason }`;
  - awaits a promise that `agent.approve(id, allow, by?)` resolves.
  - The wait honors the run's AbortSignal: Esc or abort means deny. A timeout (config
    `approvalTimeoutMs`, default 10 min) also means deny.
  - Denied: the tool result is `ERROR: denied by the user` (or the reason), so the loop never
    crashes.
  - Then it emits `approval_end { id, allow, by: "tui" | "app" | "telegram" | "timeout" | "abort" }`.
- **"Allow for this session"**: the agent remembers the (tool, normalised command) pair in memory
  for the run's session. It is never saved to disk.
- **rpc** (`src/rpc.ts`): a new command `approve {id, allow, remember?}`; the events pass through
  unchanged.
- **Hub**: relays `approval_request`/`approval_end` like any event, and takes `approve {agent, id,
  allow, remember?}` from a device. Add both to `docs/protocol.md` (still protocol 1: new
  messages, nothing changed).
- **First answer wins**: the others receive `approval_end` and update their UI (TUI prompt gone,
  phone card resolved, Telegram message edited to "✓ allowed from the terminal").

What each client does:

- **The TUI**: a prompt above the editor, in the marker's place, styled like the queue: the command
  in cream, then `y allow · n deny · a allow for this session`. Keys go to it first while it shows
  (as the menu takes its keys). Esc denies, so interruption stays first-class (`docs/interruption.md`).
- **permission-gate**: a gated command returns `ask` instead of a block. `KINOKO_YOLO=1` still
  allows it outright; the hardline still blocks, never asks. Mirror the new type in
  kinoko-extensions' `api.ts`.
- **The phone**: a card in the chat with the command and Allow / Deny / For this session buttons,
  plus a notification when the app is in the background (`Notifier.kt`). Do this in its own branch
  after the core.

## The menu: `/integrations`

- **Root**: add `{ name: "integrations", description: "Telegram (and more later): notifications,
  prompts, approvals" }` to `ROOT`.
- **Root page** (`ListPage`): one item per integration with its state, `●` connected, `○` set up
  but off, no mark for not set up. Only Telegram for now. Enter opens its page.

### Telegram setup, step by step

1. **Create the bot** (`InfoPage`). Text: open Telegram, talk to **@BotFather**, send `/newbot`,
   pick a name and a username ending in `bot`, copy the token it gives. The page's hint is "Enter
   to continue".
2. **Token** (`InputPage`, `secret: true`): paste it.
   - Check it with `getMe` (AbortSignal, ~10 s timeout).
   - Right: go on and show `@username`. Wrong: stay on the page and say why ("Telegram says the
     token is not valid").
3. **Pairing** (`InfoPage`, refreshed while it waits). It shows "Send `/start 4831` to
   @username", with a one-use code that expires in 10 minutes, like device pairing.
   - Poll `getUpdates` until a private message carries the code.
   - Save that chat id. Answer in the chat "🍄 paired with <machine>". The page shows the person's
     name and goes on.
   - Esc cancels and the poll aborts.
4. **Options** (`ListPage`, `stay: true`), each toggled with Enter:
   - notify when a run ends (on; only runs of 30 s or more);
   - take prompts from Telegram (on);
   - approvals in Telegram (on);
   - send a test message.

   A last item, "Disconnect", forgets the token and the chat (Del twice, like removing an
   extension).

**Where it is stored**: `~/.kinoko/integrations.json`, mode 600:

```json
{ "telegram": { "token": "…", "bot": "username", "chat": 123456789, "name": "…",
  "notify": true, "prompts": true, "approvals": true, "on": true } }
```

New file `src/integrations.ts` reads and writes it (like `src/disabled.ts`). Never log the token
and never put it in an error message.

**Who runs the bridge**: the hub. The TUI's page says whether `kinoko serve` is running ("the bot
answers while `kinoko serve` runs"). The hub rereads `integrations.json` when its mtime changes:
check it on each poll round, no watcher needed.

**The phone**: optional, later. An `integrations` entry in `commands.ts` could show the state as a
list. Setup stays in the TUI (pasting a token on the phone is fine too, but not needed now).

## The Telegram bridge (in the hub)

Files (each under ~300 lines):

- `src/serve/telegram.ts`: the Bot API client. `getMe`, `getUpdates` (long poll, offset
  handling), `sendMessage`, `editMessageText`, `answerCallbackQuery`. Every call takes an
  AbortSignal. `apiBase` is injectable for the tests.
- `src/serve/bridge.ts`: chat ↔ hub. It subscribes to agents' events like a device, maps
  Telegram message ids to agents, and owns the rules below.
- Wire it in `src/serve/main.ts` next to `listenForTerminals`. Stop it with the hub's abort.

In the chat:

- **A run ended** (`AgentInfo.ended`, run ≥30 s, notify on): "🍄 *project* · done in 2m 10s",
  then the reply's start (or the whole reply when short), as HTML.
  - Telegram *reply* to that message → a prompt to that agent; a follow-up if it is running again.
  - Error and limit endings say so; aborted ones stay quiet (the user aborted them).
- **Plain text** (prompts on): goes to the selected agent, the last one notified or picked.
  - None selected: "which agent?" with the agents as inline buttons.
  - Running: it becomes a steer. Answer "↪ sent as a steer".
- **Commands**: set them with `setMyCommands` so Telegram offers them.
  - `/agents`: list with state, buttons to select.
  - `/new <project>`: a project from the hub's projects list, as buttons.
  - `/stop`: abort.
  - `/status`.
  - `/compact`, `/models`: through `runCommand` (`src/commands.ts`).
- **Approvals** (approvals on): "🔐 *project* wants to run:", the command in `<pre>`, the reason,
  and buttons ✅ Allow · ❌ Deny · ✅ This session.
  - The `callback_query` → `approve` on that agent; answer the callback.
  - Edit the message to the outcome, also when another client answered first (`approval_end`).
- **Images** (later, optional): a photo sent to the bot → `images` on the prompt (the protocol
  takes them already).

## Security

- **Token**: `integrations.json` at 600, never logged, never sent anywhere but api.telegram.org.
- **Who is obeyed**: only the paired chat id. Pairing needs the one-use code shown in the user's
  own terminal, so finding the bot's username is not enough.
- **Privacy**: replies and commands go through Telegram's servers. Tell the user once, in the setup
  page. "Notify only" (prompts and approvals off) is one toggle away.
- **Approvals from Telegram**: same weight as from the TUI. The hardline is never askable, so no
  Telegram tap can run it.
- **The user's running hub**: never test against it. Use a sandbox hub on port 7979 with a sandbox
  HOME, as the phone work did (see "Testing").

## Testing

- **Fake Bot API**: a `Bun.serve` answering `getMe`, `getUpdates` (held, then answered, so long
  polling is real), `sendMessage`, `editMessageText` and `answerCallbackQuery`, recording calls.
  The same idea as the fake SSE server for providers. Tests go in `src/testing/serve/telegram.test.ts`
  and `bridge.test.ts`.
- **Approvals**: loop tests with a fake provider that calls a gated tool. Cover:
  - an answer arrives: allow runs the tool, deny gives an `ERROR:` result;
  - an abort mid-wait denies within 100 ms;
  - the timeout denies;
  - "this session" skips the next ask;
  - every tool call still ends with exactly one result.
- **TUI**: `src/testing/tui/app.test.ts`'s harness. Cover the prompt keys (y, n, a, Esc) and the
  setup pages (an injected fake API base: token wrong then right, pairing code matched, options
  toggled).
- **By hand, at the end**: the user creates the bot and pastes the token in the menu. Never ask for
  the token in chat and never put it in a commit or a test.
- **Sandbox**: a sandbox `HOME` with symlinked `config.json`, `models.json`, `ext`, `skills` and
  `registry`, then `HOME=$SB bun src/main.ts serve --local --port 7979`. Delete the sandbox after.

## Order of work (one branch each, merge when the user says)

1. `feat/approvals`: the `ask` hook type, loop wait (abort, timeout, session memory), events, rpc
   `approve`, the TUI prompt, permission-gate asks (kinoko-extensions: its own branch, `api.ts`
   mirrored), tests, `docs/interruption.md` mentions the wait.
2. `feat/approvals-hub`: protocol messages, hub relay, `docs/protocol.md`; the Android card and
   notification (kinoko-android, its own branch).
3. `feat/integrations-menu`: `src/integrations.ts`, the `/integrations` pages, Telegram setup
   (getMe, pairing, options), the Bot API client it needs (`src/serve/telegram.ts`).
4. `feat/telegram-bridge`: `src/serve/bridge.ts` in the hub: notifications, prompts, commands,
   approvals.
5. Later, each its own plan: Discord (a bot, same shape), GitHub (the `github` extension exists;
   perhaps notifications on CI), Gmail (OAuth: a bigger question).

Ask the user at the start of step 3 (or settle in one line and say so): the notify threshold (30 s?),
and whether Telegram may start new agents or only talk to running ones.

## House rules that bite here

- Every change gets a branch. `bun run check` passes with zero warnings. Append to
  `docs/PROGRESS.md`. Rebuild and install the binary
  (`bun run build && install -m 755 kinoko-out/kinoko ~/.local/bin/kinoko`) when runtime behavior
  changes. Merge `--no-ff` only when told, then `git push origin main`.
- Zero runtime dependencies. No SDKs. `fetch` + AbortSignal. Nothing blocks the event loop.
- **adb**: always pass `-s <serial>`. The user's phone is often plugged in beside the emulator, and
  a bare `adb uninstall` once removed the app from the phone.
- **APKs** to the user's devices: flux-cli, as before.
- Do not restart the user's `kinoko serve`, and do not touch their `tailscale serve` on 443.
