# kinoko serve: the app protocol (version 1)

`kinoko serve` is the hub a phone app talks to. It runs agents (one `kinoko --mode rpc` child per
agent, in its project's directory), lists the kinoko TUIs open in terminals too (they link
themselves to it), and relays what they do to paired devices as it happens: not a picture of a
terminal, but the events themselves, for the app to draw natively.

```
phone app ──HTTPS/WSS──▶ Tailscale (serve or funnel) ──▶ 127.0.0.1:7878 kinoko serve ──stdio──▶ kinoko --mode rpc (per agent)
```

## Reaching it

`kinoko serve` listens on `127.0.0.1:7878` only. Tailscale brings devices in:

- **tailnet** (default): `tailscale serve` on `https://<machine>.<tailnet>.ts.net:8443`. Only your
  tailnet's devices reach it, from anywhere, encrypted end to end. The phone runs the Tailscale app.
- **Funnel** (`kinoko serve --funnel`): the same URL, open to the internet, for a device without
  Tailscale. Then only the device tokens stand guard.
- `--local`: not shared (development, tests).

Either way it is HTTPS with a real certificate. `--port` and `--public-port` (443, 8443 or 10000 for
Funnel) change the ports.

## Pairing

`kinoko serve` shows a QR code when no device is paired; `kinoko serve pair` shows a new one. It holds:

```
kinoko://pair?u=<url-encoded base URL>&c=<pairing code>
```

The code works once, for ten minutes. The app trades it for a token:

```
POST /v1/pair            {"code": "...", "name": "OnePlus 12R"}
200 {"token": "...", "device": {"id": "b913979b", "name": "OnePlus 12R"}, "version": "0.1.0", "protocol": 1}
403 {"error": "..."}     wrong, used or expired code
429 {"error": "..."}     ten wrong codes in a minute
```

Keep the token (Android Keystore). Send it as `Authorization: Bearer <token>` (or `?token=` where a
header cannot be set). `401` means the device is not (or no longer) paired: `kinoko serve revoke` on
the computer, or a lost token. Pair again.

## HTTP

| Request | Auth | Answer |
|---|---|---|
| `GET /v1/health` | no | `{"name": "kinoko", "version", "protocol": 1}`: is this a kinoko, and which protocol |
| `POST /v1/pair` | no | above |
| `GET /v1/agents` | yes | `{"agents": [AgentInfo]}` |
| `GET /v1/ws` | yes | the WebSocket |

## The WebSocket

One connection per device, JSON text messages both ways. Every message the app sends may carry an
`id`; the answer to it echoes it. Pings come from the server every ~2 minutes of silence; a dropped
connection is the app's to reopen (back off, then `attach` again: nothing is lost, see below).

### Server → app

| `type` | When | Fields |
|---|---|---|
| `hello` | on connect | `version`, `protocol`, `device {id, name}`, `agents: [AgentInfo]` |
| `agents` | an agent starts or stops, a run starts or ends; and for `list` | `agents: [AgentInfo]`, newest activity first |
| `projects` | for `projects` | `projects: [Project]` |
| `history` | for `attach` | `agent`, `info: AgentInfo`, `messages: [Message]`, `live: [AgentEvent]` |
| `event` | an attached agent did something | `agent`, `event: AgentEvent` |
| `ok` | a command was taken | `id`, and per command: `agent` (start), `text` (prompt: "started") |
| `error` | a command was refused | `id`, `detail` (a sentence for the user) |

### App → server

| `type` | Fields | Does |
|---|---|---|
| `list` | | the agents again |
| `projects` | | the projects kinoko has worked in, with their recent sessions |
| `start` | `cwd`, `session?` (an id, or `"continue"`), `model?` | starts an agent there; the app is attached to it |
| `attach` | `agent` | the conversation so far, then its events as they happen |
| `detach` | `agent` | no more events from it |
| `prompt` | `agent`, `text`, `images?` | a new run (refused while one runs: use steer) |
| `steer` | `agent`, `text`, `images?` | said to the model at its next step, mid-run |
| `follow_up` | `agent`, `text`, `images?` | queued for when the run ends |
| `abort` | `agent` | Esc: the run stops |
| `stop` | `agent` | the agent's process ends (its session stays on disk, resumable); refused for a terminal's |

`images`: `[{"mime": "image/jpeg", "data": "<base64>"}]`. Messages up to 32 MB.

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
| `request_start` | `at` | "reading the prompt…" until the first token |
| `first_token` | `at` | the model started answering |
| `thinking_delta` | `delta` | append to the thinking (dim, foldable) |
| `message_delta` | `delta` | append to the reply (markdown) |
| `tool_pending` | `name`, `args?` | a tool call being written |
| `tool_start` | `call {id, name, args}` | the call, running |
| `tool_output` | `call`, `output` | its result (`ERROR: …` is a failure) |
| `tool_end` | `call` | done |
| `message_end` | `message` | the finished message: replace what the deltas built |
| `queue_change` | `steer[]`, `followUp[]` | what waits to be said |
| `delivered` | `text` | a queued steer reached the model |
| `compacting` / `compacted` | `phase, done, total?` / `keep` | the history is being summarised |
| `retry` | `attempt, of, inMs, error` | a transient failure; trying again |
| `run_end` | `reason: done \| aborted \| error \| limit`, `detail?` | idle again |

New event types may appear: an app ignores what it does not know.
