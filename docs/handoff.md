# Handoff: where kinoko stands, and what comes next

Written 2026-10-14, at v0.3.0; updated 2026-10-15 at v0.4.0, for a new context picking the work up cold. Read this, then
AGENTS.md (the rules), then the last entries of docs/PROGRESS.md (what each branch did and did NOT do).

## The project in one paragraph

kinoko is a small coding-agent harness (TUI, print and rpc modes) on Bun and strict TypeScript,
zero runtime dependencies. Six core tools; everything else is an extension. `kinoko serve` is a hub
that runs agents for the Android app (kinoko-android) over a WebSocket, through Tailscale away
from home or the LAN at home. The owner uses it daily with local models (llama.cpp on this
machine) and drives it from a OnePlus phone. They value: a TUI that looks right, nothing the user
typed ever lost, interruption first, and code a person enjoys reading.

## The repositories (all on main, clean, pushed)

| Repo | What | Released how |
|---|---|---|
| `~/Projects/kinoko` | the harness | tag `vX.Y.Z` on main → `.github/workflows/release.yml` builds 5 binaries + SHA256SUMS |
| `~/Projects/kinoko-extensions` | extensions (each folder copied alone into `~/.kinoko/ext/<name>/`) | no release: `/extensions` installs from main; reinstalling updates |
| `~/Projects/kinoko-android` | the phone app (Kotlin, Compose) | no release yet: debug APK, installed by hand |
| `~/Projects/kinoko-skills` | skills | like extensions, from main |

Each repo has its own AGENTS.md. kinoko-android: `./gradlew testDebugUnitTest assembleDebug`.

## How the owner works (follow these)

- **One branch at a time.** Finish, report, let them test, merge only when they say so
  (`--no-ff`, "Merge branch '<name>': <what>"), push main, then start the next. If they ask for
  several things at once, do the first and say what comes next.
- **The test checklist**: the artifact "Kinoko: qué probar"
  (https://claude.ai/artifact/2qHkcfc3vr5pQPWHfz23io), collection `items`, docs
  `{order, n, group, kind, title, how, cmd, done, note}`. Add a row in the same turn as every fix or
  feature that needs their test (last one: n 75, order 157). `cmd` is ONLY what to paste into
  kinoko (the model runs whatever is in it); instructions go in `how`. Pin writes with
  `if_version`; they often mark rows done themselves, so read before writing.
- **Talk to them in Spanish**, short and concrete; code, commits and docs in English.
- After every runtime change: `bun run check` (must exit 0; do not pipe it through `tail`, that
  hides failures), an entry in docs/PROGRESS.md, and
  `bun run build && install -m 755 kinoko-out/kinoko ~/.local/bin/kinoko` (the `kinoko` on this
  machine is that binary). A running `kinoko serve` keeps the old binary until restarted: say so.
- Releases are cut when they ask ("crea la 0.x.y"): bump package.json, a CHANGELOG section,
  branch `release/vX.Y.Z`, merge, tag, push the tag, watch the workflow with `gh run watch`.

## Testing without touching their setup

- **TUI by eye**: `tmux new-session -d -s x -x 110 -y 40 "HOME=<test home> KINOKO_LINK=0 kinoko"`,
  `tmux send-keys`, `tmux capture-pane -p` (`-e` keeps colours). A test HOME lives in the
  scratchpad: copy `~/.kinoko/config.json`, `models.json` and the extensions needed into
  `<home>/.kinoko/`. `KINOKO_LINK=0` keeps the test TUI off their hub.
- **The phone app**: emulator `ANDROID_AVD_HOME=~/.config/.android/avd ~/Android/Sdk/emulator/emulator -avd kinoko -no-window -no-audio -no-snapshot-save`,
  a test hub `HOME=<test home> kinoko serve --local --no-lan --port 7880`,
  `adb -s emulator-5554 reverse tcp:7880 tcp:7880`, pair with
  `adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d "'kinoko://pair?u=http%3A%2F%2F127.0.0.1%3A7880&c=<code>'"`
  (the code is in the hub's log). Screenshots: `adb -s emulator-5554 exec-out screencap -p`.
  **Always `adb -s`**: their OnePlus (`df6030eb`) is often plugged in by USB.
- **Getting an APK to their phone**: by USB `adb -s df6030eb install -r app/build/outputs/apk/debug/app-debug.apk`
  (keeps the pairing), or over Flux: `flux-cli --device 94103ff1e97a45209916409fed00b799 send <apk>` (OnePlus 12R).
- Never `pkill -f` a pattern that also matches your own shell's command line: kill by pid.

## Their machine right now

- Model server on `:8085` (llama.cpp) serving **MiniCPM-V-4.7-35B-A3B**; `~/.kinoko/config.json`
  names it (they made it the default with D in /models). Strata on `:8081` is a saved model.
- Profile in use: amanita. `~/.kinoko/profiles.json` overrides: morchella has `latex` added.
- `kinoko serve` runs as their hub (port 7878, Tailscale + LAN); `tailscale status` shows the phone.

## What changed in the last sessions (0.2.0 → 0.3.0)

- 0.2.1: shells left running are told and end with kinoko; the todo tool is the side panel's list;
  render fixes (steer smear, /jobs growing, resize scrollback). The hardline regex in permission-gate.
- 0.2.2: `/thinking` reaches llama.cpp; a row per tool call; LaTeX math (`latex` extension).
- 0.2.3: ↑/↓ walk the messages sent; D in /models makes the default; unknown window → 128k default;
  cream notes; the phone's agents list follows the model; LaTeX in the app.
- 0.3.0: history kept across runs (`~/.kinoko/history.jsonl`); a warning at start when the endpoint
  does not serve the configured model; Stop for a shell in the app (`/jobs stop #N`);
  **src/tui/app.ts split into 13 named parts** (its header is the map; read it before touching the TUI).

## Loose ends (known, not asked for yet; do not start them unprompted)

- The model check at start is TUI only (an rpc agent from the phone does not say it).
- Messages typed on the phone are not in the TUI's history.
- app.ts is 648 lines (its constructor is ~190 lines of wiring); run-view.ts is 324.
- LaTeX inside thinking blocks stays as TeX.
- Ideas floated earlier: a job's end note headlining "ended at once but left processes running";
  a non-blocking `music wait` in cliamp.
- Android: the release build still signs with the debug key; no npm package; no FUNDING.yml.

## Next (the owner's list, 2026-10-15)

1. **The APK grew from ~2 MB to ~20 MB recently**: find out why (a dependency, resources, an
   unshrunk release, native libraries) and bring it back down.
2. **The voice on the phone**: the app should hear kinoko talk too (and maybe speak to it). The
   voice today lives in the `voice` extension on the computer (whisper.cpp in, Qwen3-TTS out:
   docs/voice.md); the phone would need the hub to stream the audio, a feature of its own.

## Voice: talking with kinoko (done, 2026-10-15, v0.4.0)

docs/voice.md is the design and what was built. The core has the hooks (agent_event, interrupt,
registerKey, send, status; Alt+X stops tools too); the rest is the `voice` extension in
kinoko-extensions (its README documents every backend). This machine: whisper.cpp and qwentts.cpp
under `~/Projects`, `~/bin/tts-serve.sh` (:8091), `~/.kinoko/voice.json`, `~/.kinoko/voices/`
(wheatley), PipeWire echo cancelling as the user service `kinoko-echo-cancel`. The TTS needs ~2.6 GB
of VRAM: start the LLM with `NCMOE=38 ~/bin/minicpm-serve.sh` (or `NCMOE=36` for lfm-serve.sh).

## Kinoko Lab, the harness flow visualizer (done, 2026-10-14)

Design: docs/visualizer.md (its "Decisions" and "Order of work"). Shipped on main: step 1, the
loop's finer events and `inspect` (feat/lab-events); step 2, the live page at `/lab`
(feat/lab-page: src/serve/lab, `kinoko serve lab`, a QR for the LAN and one for Tailscale).
The owner does not miss replay (step 3): dropped. Breakpoints (step 4) stay an idea only, not a
to-do; if ever built, from the page only (the TUI is not touched). To see it: a test hub
(`kinoko serve --local --no-lan --port 7880` with a test HOME), `kinoko serve lab` with the same
HOME, a TUI with that HOME (it links itself), and headless Chromium driven over CDP for screenshots
(`chromium --headless=new --remote-debugging-port=9333`).

The brief it started from:

The owner definitely wants this, "for me and for the world to understand what a harness is":
an interactive, live diagram of everything kinoko does, web, beautiful, **"like Factorio"**, in
kinoko's look (modern, the kind of thing shared on X about frontier models), and above all
**educational**: what is it doing right now, and why. Stretch goal: **breakpoints and stepping**.

Agreed order: **a design document first** (docs/visualizer.md), reviewed with them before any code.
What it should settle:

1. **The machines** (the phases a reader should see): the system prompt being built (AGENTS.md,
   skills, the tools' schemas), the request, the stream (thinking, text, tool calls being written),
   the dispatch of calls, the extensions' gates (permission-gate, approvals), the tools running
   (background jobs as their own lane), the results going back into the history, compaction,
   steers and follow-ups entering the queue, the run's end and why.
2. **The events**: `kinoko serve` already streams the agent's events over its WebSocket
   (docs/protocol.md). The loop (src/loop.ts) will need a few finer ones (prompt built, request
   sent with its size, a call dispatched to a tool, a gate's decision, a result appended). Keep them
   cheap and off by default if they cost anything.
3. **Where it lives**: probably a page served by `kinoko serve` (zero dependencies: hand-written
   SVG/canvas, no framework), or an extension. Policy-in-extensions is a hard rule: if it is not
   core, it is an extension.
4. **Clicking a machine shows its contents** at that moment: the exact prompt, the request JSON, the
   call's args, what came back. This is the educational core.
5. **Breakpoints**: the loop awaiting a gate before a phase when a breakpoint is set; continue /
   step sent back over the same protocol. It touches the loop's heart: interruption must stay
   first-class (every await abortable; nothing blocks the event loop).
6. **The look**: kinoko's palette (cream, amanita red, the mushrooms), items moving on belts
   between machines, readable at a glance and on the phone.

Prior art worth a look (none does this live and in this style, as far as known): LangSmith and
Langfuse traces, OpenAI's agent tracing; they are after-the-fact trace viewers.
