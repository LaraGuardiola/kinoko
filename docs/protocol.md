# kinoko serve: the app protocol (version 1)

`kinoko serve` is the hub a phone app talks to. It runs agents (one `kinoko --mode rpc` child per
agent, in its project's directory), lists the kinoko TUIs open in terminals too (they link
themselves to it), and relays what they do to paired devices as it happens: not a picture of a
terminal, but the events themselves, for the app to draw natively.

```
phone app ──HTTPS/WSS──▶ Tailscale (serve or funnel) ──▶ 127.0.0.1:7878 kinoko serve ──stdio──▶ kinoko --mode rpc (per agent)
phone app ──HTTPS/WSS (pinned certificate)──▶ <LAN IP>:7879 kinoko serve            (the same hub, at home)
```

## Reaching it

`kinoko serve` listens on `127.0.0.1:7878` only. Tailscale brings devices in:

- **tailnet** (default): `tailscale serve` on `https://<machine>.<tailnet>.ts.net:8443`. Only your
  tailnet's devices reach it, from anywhere, encrypted end to end. The phone runs the Tailscale app.
- **Funnel** (`kinoko serve --funnel`): the same URL, open to the internet, for a device without
  Tailscale. Then only the device tokens stand guard.
- **The local network** (default too, `--no-lan` turns it off): `https://<LAN IP>:7879`
  (`--lan-port`), with the hub's own certificate (`~/.kinoko/tls`, EC P-256, self-signed, made once).
  Nobody can vouch for a certificate on 192.168.x, so the app pins it: the QR carries its fingerprint
  and the app trusts that certificate only. At home no Tailscale is needed; the app tries this
  address first (3 s), then the main one. A firewall must let the port in from the local network.
- `--no-tailscale`: the local network only. `--local`: not shared at all (development, tests).

Either way it is HTTPS with a real certificate. `--port` and `--public-port` (443, 8443 or 10000 for
Funnel) change the ports.

## Pairing

`kinoko serve` shows a QR code when no device is paired; `kinoko serve pair` shows a new one. It holds:

```
kinoko://pair?u=<url-encoded base URL>&c=<pairing code>[&l=<url-encoded LAN URL>&f=<fingerprint>]
```

`u` is the main address (the tailnet's; the LAN's when Tailscale is off). `l` and `f`, when the hub
listens on the local network: its https address there and the SHA-256 of its certificate (DER),
base64url without padding. The app pairs and connects there first, trusting only that certificate.

The code works once, for ten minutes. The app trades it for a token:

```
POST /v1/pair            {"code": "...", "name": "OnePlus 12R"}
200 {"token": "...", "device": {"id": "b913979b", "name": "OnePlus 12R"}, "version": "0.1.0", "protocol": 1, "lan": {"urls": [...], "fingerprint": "..."}}
403 {"error": "..."}     wrong, used or expired code
429 {"error": "..."}     ten wrong codes in a minute
```

Keep the token (Android Keystore). Send it as `Authorization: Bearer <token>` (or `?token=` where a
header cannot be set). `401` means the device is not (or no longer) paired: `kinoko serve revoke` on
the computer, or a lost token. Pair again. Forgetting the computer in the app sends
`DELETE /v1/device` first, so the computer forgets the device too (no stale entry left behind).

## HTTP

| Request | Auth | Answer |
|---|---|---|
| `GET /v1/health` | no | `{"name": "kinoko", "version", "protocol": 1}`: is this a kinoko, and which protocol |
| `POST /v1/pair` | no | above |
| `GET /v1/agents` | yes | `{"agents": [AgentInfo]}` |
| `GET /v1/ws` | yes | the WebSocket |
| `DELETE /v1/device` | yes | `{"ok": true}`: this device unpairs itself; its sockets close (4001) |

## The WebSocket

One connection per device, JSON text messages both ways. Every message the app sends may carry an
`id`; the answer to it echoes it. Pings come from the server every ~2 minutes of silence; a dropped
connection is the app's to reopen (back off, then `attach` again: nothing is lost, see below).

### Server → app

| `type` | When | Fields |
|---|---|---|
| `hello` | on connect | `version`, `protocol`, `device {id, name}`, `agents: [AgentInfo]`, `lan {urls, fingerprint}` when it listens on the LAN (a new IP reaches the app), `profile` (the one in use: the app draws its mushroom) |
| `profile` | the profile in use changed on the computer (checked every 3 s) | `profile` (a name, or null) |
| `agents` | an agent starts or stops, a run starts or ends; and for `list` | `agents: [AgentInfo]`, newest activity first |
| `projects` | for `projects` | `projects: [Project]` |
| `folders` | for `folders` | `path` (the one asked), `folders: [string]`: absolute paths |
| `history` | for `attach` | `agent`, `info: AgentInfo`, `messages: [Message]`, `live: [AgentEvent]` |
| `event` | an attached agent did something | `agent`, `event: AgentEvent` |
| `ok` | a command was taken | `id`, and per command: `agent` (start), `text` (prompt: "started") |
| `rendered` | for `render` | `lines`: the rows, each `width` columns, with ANSI colours (24-bit and 256) |
| `commands` | for `commands` | `agent`, `commands: [{name, description, kind: "list" \| "run"}]` |
| `command_result` | for `command` | `agent`, `result: {title?, text?, items?, hint?, reset?}` |
| `inspected` | for `inspect` | `agent`, `what`, `data`: the last request as sent (`{model, effort?, budget?, system, tools, messages}`, image bytes left out), the system prompt (a string) or the tools (`[{name, description, schema}]`) |
| `error` | a command was refused | `id`, `detail` (a sentence for the user) |

### App → server

| `type` | Fields | Does |
|---|---|---|
| `list` | | the agents again |
| `projects` | | the projects kinoko has worked in (not under /tmp, still there), with their recent sessions |
| `folders` | `path` (as typed; `~` is the home) | the folders that complete it: inside it when it ends in `/`, else those starting with its last part |
| `start` | `cwd` (`~` allowed), `session?` (an id, or `"continue"`), `model?` | starts an agent there; the app is attached to it |
| `attach` | `agent` | the conversation so far, then its events as they happen |
| `detach` | `agent` | no more events from it |
| `prompt` | `agent`, `text`, `images?`, `files?` | a new run (refused while one runs: use steer) |
| `steer` | `agent`, `text`, `images?`, `files?` | said to the model at its next step, mid-run |
| `follow_up` | `agent`, `text`, `images?`, `files?` | queued for when the run ends |
| `abort` | `agent` | Esc: the run stops |
| `stop` | `agent` | the agent's process ends (its session stays on disk, resumable); refused for a terminal's |
| `commands` | `agent` | the slash commands it takes → `commands` |
| `render` | `text`, `width` | a fenced block or a table drawn as the TUI draws it → `rendered` |
| `command` | `agent`, `name`, `arg?` | runs one → `command_result` |
| `inspect` | `agent`, `what: "request" \| "system" \| "tools"` | what the model sees → `inspected` (Kinoko Lab, when a machine is opened: too big to send with every request); an error before the first request |
| `approve` | `agent`, `request`, `allow`, `remember?` | answers the call waiting (`AgentInfo.approval.id`): `allow` runs it, `remember` allows the same call for the rest of the session; refused when another client answered first |

`images`: `[{"mime": "image/jpeg", "data": "<base64>"}]`. Messages up to 32 MB.

`files`: `[{"name": "report.pdf", "mime": "application/pdf", "data": "<base64>"}]`: saved on the
computer in `~/.kinoko/uploads/` (`<time>-<n>-<name>`, the name cut to its last part), and the
message gets a line per file, `[sent from the phone: <path> (<size>)]` (a message of files alone is
just those lines). A PNG, JPEG, GIF or WebP up to 3.75 MB also goes to the model as an image: send a
photo downscaled.

### Attaching mid-run

`history.messages` is the conversation up to its last finished message; `history.live` the events of
the run in progress since then (the reply streaming now, a tool running). Draw the messages, replay
`live` as if it were arriving, then keep going with `event`s. The same after a reconnect.

## Terminals

A kinoko TUI started while the hub runs (or one that finds it within ~3 s of it starting) links
itself through the hub's Unix socket `~/.kinoko/serve.sock` (mode 600: this user's processes only),
speaking the rpc mode's JSONL after a first `{"type": "hello", "origin": "terminal", "cwd", "pid",
"model", "session", "running"}` line. It is listed with `origin: "terminal"` while it stays open; the
phone attaches to it, prompts it (the terminal shows the prompt as the user's), steers and aborts it like
any agent, but cannot `stop` it: it ends in its terminal. `KINOKO_LINK=0` keeps a terminal out.

## Slash commands

What the TUI's menu does, for a client without it: `new`, `compact`, `thinking`, `extensions`,
`skills`, `session` (each agent says which it takes). A `list` command answers with `items`
(`{name, description, current?, off?, installed?, shared?}`: in effect, switched off, installed, a
skill shared with other agents) to act on with an `arg`: `thinking` takes a profile's name; the
catalogs take `on NAME`, `off NAME`, `install NAME`, `update NAME`, `remove NAME`, and answer with
the list again and a `text` saying what was done. `jobs` lists the shells; `#ID` answers with one's
window (its last lines in `text`, its command in `hint`), and `stop #ID` stops it and answers with
that window. A `run` command answers with a `text`; `reset:
true` (new) means the conversation was replaced: attach again. A TUI linked to the hub runs them
through itself, so its screen shows what the phone changed.

## Approvals

An extension can ask the user before a tool call runs (permission-gate does for `sudo`, `rm -rf`…).
The agent waits: `approval_request` comes as an event to attached devices, and the agent's
`AgentInfo.approval` says it in the `agents` list every device gets (attached or not: that is the one
to notify from, as with `ended`). Any client may answer with `approve`; the first answer wins (the
terminal's y/n, the phone, later Telegram) and `approval_end` says who (`by`). Show the call
(`call.name`, and `call.args.command` for `bash`), the `reason`, and Allow / Deny / For this session.
An abort of the run, or nobody answering in 10 minutes (`approvalTimeoutMs`), denies it.

## Shapes

```ts
AgentInfo {
  id: string; cwd: string; project: string; model: string;
  origin: "app" | "terminal";   // started by the hub, or a kinoko TUI linked to it
  state: "starting" | "idle" | "running" | "exited";
  session?: string;      // its session id: resumable with start {session}
  title?: string;        // the first prompt, as a name
  started: number; activity: number;   // epoch ms
  error?: string;        // why it exited
  ended?: "done" | "aborted" | "error" | "limit";   // how its last run ended (none while one runs)
  last?: string;         // the start of its last reply, one line: what a notification says
  approval?: { id: string; call: { id: string; name: string; args: object }; reason: string };   // a call waiting for the user
  jobs?: number;         // background jobs running in it (none: no field)
}

Project { cwd: string; name: string; updated: number; sessions: [{ id: string; title: string; updated: number }] }

Message {
  id: string; role: "user" | "assistant" | "tool"; content: string;
  thinking?: string;
  toolCalls?: [{ id: string; name: string; args: object }];   // assistant
  toolCallId?: string;                                        // tool: the call it answers
  images?: [{ mime: string; data: ""; size: number }];        // bytes stay on the computer
  stop?: "end" | "tool_use" | "length" | "aborted" | "error";
  usage?: { input: number; output: number; cacheRead?: number; cost?: number };
}
```

`AgentEvent` (from `src/loop.ts`), in the order a run produces them:

| `type` | Fields | Draw it as |
|---|---|---|
| `run_start` | `prompt` | the user's message; the agent is working |
| `request_start` | `at`, `model`, `messages`, `tools`, `chars`, `tokens` (an estimate) | "reading the prompt…" until the first token; what the request carries |
| `prefill` | `done`, `total` | prompt tokens the engine has read so far (llama.cpp), a few times a second |
| `first_token` | `at` | the model started answering |
| `thinking_delta` | `delta` | append to the thinking (dim, foldable) |
| `message_delta` | `delta` | append to the reply (markdown) |
| `tool_pending` | `name`, `args?`, `index?` | a tool call being written; `index` tells the calls of one reply apart |
| `tool_start` | `call {id, name, args}` | the call, running |
| `gate` | `call`, `decision: pass \| block \| ask`, `by?` (the extension), `reason?`, `rewritten?`, `skipped?: auto \| remembered` | the extensions' word on the call, before it runs (`skipped`: an ask nobody is asked) |
| `tool_output` | `call`, `output` | its result (`ERROR: …` is a failure) |
| `tool_end` | `call` | done |
| `message_end` | `message` | the finished message: replace what the deltas built |
| `appended` | `role`, `kind: prompt \| steer \| follow_up \| reply \| result \| note \| nudge`, `chars`, `text?` | a message joined the history; `text` only for what the harness wrote itself (a note, a nudge) |
| `guard` | `what: repeat \| empty \| length \| same_call \| same_error \| unknown_tool`, `detail` | a guard noticed something (a nudge or a warning follows) |
| `queue_change` | `steer[]`, `followUp[]` | what waits to be said |
| `delivered` | `text` | a queued steer reached the model |
| `compacting` / `compacted` | `phase, done, total?` / `keep` | the history is being summarised |
| `retry` | `attempt, of, inMs, error` | a transient failure; trying again |
| `jobs` | `running` | how many background jobs run now (it updates `AgentInfo.jobs`; not replayed) |
| `model` | `model` | the model was switched, from the app, the TUI or Telegram (it updates `AgentInfo.model`; not replayed) |
| `approval_request` | `id`, `call {id, name, args}`, `reason` | the call waits for the user: Allow / Deny / For this session |
| `approval_end` | `id`, `allow`, `by: tui \| app \| telegram \| timeout \| abort` | answered: the card shows the outcome |
| `run_end` | `reason: done \| aborted \| error \| limit`, `detail?` | idle again |

`prefill`, `gate`, `appended` and `guard` are for Kinoko Lab: a chat need not draw them. New event
types may appear: an app ignores what it does not know.
