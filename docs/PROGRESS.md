# Progress

## Phase 1: skeleton, shared types, provider, print mode, lint ✅ DONE

Created all files specified in the phase spec:
- `package.json` (type:module, scripts: start/lint/test/check, devDeps only typescript/@types/bun/oxlint)
- `tsconfig.json` (strict, bun types)
- `.oxlintrc.json` (correctness=error, suspicious/perf=warn, no-explicit-any=warn)
- `src/types.ts` (exact contracts as spec)
- `src/config.ts` (layered config: defaults < ~/.kinoko/config.json < ./.kinoko/config.json < CLI flags)
- `src/providers/openai-compat.ts` (raw fetch, hand-written SSE parser, accumulates tool-call args, emits no partial tool calls on abort)
- `src/main.ts` (`bun run src/main.ts -p "prompt"` print mode)
- `src/providers/openai-compat.test.ts` (4 tests via Bun.serve fake SSE server)

`bun run check` passes with zero warnings; all 4 tests pass.

Assumptions: none beyond spec — default model `gpt-4o-mini`, base URL `https://api.openai.com/v1`, contextWindow 128_000.
Phase 2: agent loop with abort, steer and follow-up — DONE. src/loop.ts, src/loop.test.ts. All 13 tests pass, bun run check zero warnings. Rules 1-8 implemented + 9 (compaction placeholder).
Phase 3: core tools + output budget — DONE.
- Done: src/tools/budget.ts (estimateTokens chars/4; budget() spills full output to .kinoko/spill/<id>.txt, keeps head+tail), src/tools/tracker.ts (read-before-change tracker, Bun.hash), read.ts (line-numbered, offset/limit, binary refusal), write.ts (mkdir -p, read-before-overwrite, changed-on-disk detection), edit.ts (exact-substring edits: unique match required, not-found vs ambiguous(N) errors with closest-line hints, overlapping edits rejected all-or-none, NFKC+smart-quote+trailing-ws normalization for matching but original bytes preserved), bash.ts (detached sh -c in own process group; abort/timeout SIGKILL the whole group; output through budget()), tracker.ts, registry.ts (defaultTools = read/write/edit/bash).
- Tests: src/tools/tools.test.ts — 10 acceptance tests in temp dirs (read paging/binary, read-before-edit, write mkdirs/read-before-overwrite/stale detect, edit unique/ambiguous/overlap, bash spill spill-file readable, abort kills group <200ms, timeout kills group). bun run check: lint+tsc+test all pass, zero warnings (23 tests).
- Assumptions: spill files go to <cwd>/.kinoko/spill/; bash default no timeout, budget maxTokens 4000; tracker is a per-process singleton (reset() for new session); abort returns exactly "Aborted by user".

## Phase 4: the search tool — DONE
- Done: src/tools/search.ts (tool + schema, query building, content/files rendering, token budget with early kill, ranking by match count then mtime, truncation hint, "Aborted by user"), src/tools/search-backends.ts (3 backends: rg on PATH -> pinned ripgrep download to ~/.kinoko/bin (gunzip + hand-rolled tar + sha256 + run-verify, graceful fall-through) -> pure-Bun fallback with Bun.Glob.scan, chunked Bun.file().slice() reads, basic .gitignore matcher, smart-case). Registered searchTool in registry.ts.
- Streaming: rg --json parsed as NDJSON events; async pump generator kills the child on early exit / abort / 10s timeout; abort honored via AbortSignal listener.
- Tests: src/tools/search.test.ts — 4 acceptance tests (identical rg vs bun output incl. files mode; budget cap + hint + early exit measurably faster; abort kills rg process; .gitignore respected by both, no_ignore override). bun run check: lint+tsc+test all pass, zero warnings (27 tests).
- Assumptions: pinned ripgrep 14.1.1 musl (x64) / aarch64-gnu (arm64) with sha256 pins; KINOKO_RG_BACKEND=bun forces the fallback (test hook); KINOKO_RG_URL overrides the pinned URL; fallback .gitignore matching is root-level only (no nested/nested ignore files); paths in output are relative to the search path; default max_tokens 2000, hard timeout 10s.
- NOT done: search-backends.ts is ~710 lines (over the ~300-line guideline); the spec names only these two files, so no third file was invented. The download/unpack part is self-contained and the obvious candidate for one.

## Phase 4b: local engine compatibility (Strata / llama.cpp style) — DONE
- Done: config `reasoningEffort` ("off"|"low"|"medium"|"high") + `maxOutputTokens` (default 8192) with `--reasoning-effort` / `--max-output-tokens` flags; `reasoning_effort` / `max_tokens` go into the body only when the option is set. `StreamEvent {type:"thinking"}` + `Message.thinking` (display and session logs only, never sent back). openai-compat maps `delta.reasoning_content` / `delta.reasoning` to thinking (never mixed into text), always sends `stream_options.include_usage`, maps prompt_tokens/completion_tokens and `prompt_tokens_details.cached_tokens` to cacheRead. `<think>` fallback lives in src/providers/think-split.ts (moved out to keep openai-compat.ts under 300 lines): state machine across chunk boundaries, armed only once a tag is first seen, so plain content streams straight through. No request and no idle timeouts anywhere in src/ — only the AbortSignal ends a request, and it reaches `fetch`, so abort closes the HTTP connection immediately. Loop emits `request_start` + `first_token` AgentEvents with epoch timestamps. examples/config.strata.json matches docs/engines/strata.md.
- Probe: docs/engines/strata-probe.txt now holds the real report from the engine on port 8081 (Qwen3.8-Flash-Next-Coder IQ1, n_ctx 122880) — all five checks OK: thinking in `delta.reasoning_content` (no `<think>` in content), tool args stream as fragments that concatenate to valid JSON, **abort really frees the engine** (next request's first delta 1.1s after a cut generation), the prompt prefix is reused (13.1s cold vs 0.42s warm), and a usage chunk with cached_tokens is sent. `reasoning_effort` is honored live ("off" sent 0 reasoning frames, "low" sent 34) and Kinoko's print mode answers normally against it. Port 8081 in strata.md, the example config and the probe default.
- Fixed: scripts/probe-engine.ts did not run at all (duplicate `blank()`, undefined `line()`, dead vars, inverted prefix-reuse comparison) and its lint errors broke `bun run check`. It also `JSON.parse`d raw SSE lines including the `data: ` prefix, so every frame was dropped and all five checks reported SUSPECT; it now parses frames, skips `: keep-alive` comments, and times the first delta carrying output instead of the first byte (the engine sends an empty first frame straight away, so first byte proves nothing).
- Tests: src/providers/engine-compat.test.ts — acceptance 1-5 against a Bun.serve fake SSE server (reasoning fields never leak into text; `<think>` split inside both tags across chunks with clean text; the splitter stays disarmed until a tag appears; reasoning_effort/max_tokens only when configured; first byte after 3s does not time out; usage chunk with and without cached tokens). src/loop.test.ts 10-11: two prompts plus a mid-run extra request never overlap (peak in-flight 1; that mid-run request is the path Phase 5 compaction will use) and request_start/first_token bracket a request. bun run check: lint+tsc+test all pass, zero warnings (35 tests).
- Spec branch NOT needed: because check 3 said OK, the "SUSPECT: server kept generating after abort" path (startup warning, capped maxOutputTokens, note in strata.md) is deliberately absent — the probe says no workaround is required, and no hacks were added.
- Assumptions: since maxOutputTokens defaults to 8192, max_tokens is always sent; "only when set" is honoured at the provider level, i.e. `openaiCompat()` built without the option sends neither key. The `<think>` splitter is kept even though this engine never emits tags: it is disarmed until a tag appears, and llama.cpp chat templates of other engines do use them.

## Phase 5: session persistence, context discovery, compaction — DONE
- Done: `src/session.ts` (append-only JSONL at `~/.kinoko/sessions/<project-hash>/<id>.jsonl`; records are session/message/head/compaction; every message gets a parentId; `create`/`load`/`append`/`activeBranch`/`view`; `--continue` resumes the newest session of the project). `src/context.ts` (AGENTS.md else CLAUDE.md per directory, walked to the filesystem root and returned ROOT-FIRST as `<ctx path>` blocks; `.agents/skills/*/SKILL.md` from the project then `~`, frontmatter name+description only, emitted as an XML index with no bodies). `src/prompt.ts` (persona + tool list + 4 guidelines + date + cwd + context + skills index; 9 fixed lines, no clock read inside, so the prefix is byte-stable). `src/compact.ts` (late trigger at `contextWindow - 16384`, reactive retry on a provider overflow error, ~20k-token verbatim tail, head summarized by the same model with Objective/Decisions/Work State/Next Step/Relevant Files, previous summary passed in to be merged, the run's abort signal honoured). `src/loop.ts` (every finalized message appended through `#push`, compaction before an oversized request and after an overflow error, new `compacted` AgentEvent). `src/main.ts` (print mode now runs the Agent with tools, thinking and tool activity on stderr, text on stdout; `--continue`/`-c` resumes).
- Cache-friendly history held in practice: on the live engine a resumed 6358-token prompt came back as `prompt_tokens 6358, cached_tokens 6316`, i.e. the whole prefix was reused. Verified byte-identical replay in a test too.
- Found and fixed a real bug on the way: `Bun.file(p).writer()` writes at offset 0 instead of appending, so a resumed session overwrote its own log. Appends now use `appendFile` (O_APPEND), which is what an append-only log needs; a test covers resume-then-append.
- Tests: `src/session.test.ts` (6: append-only shape with parentIds, resume + head pointer fork, resumed aborted run with every tool call paired with exactly one result, byte-identical request bodies for two replays, `--continue` picks the newest, compaction record -> summary + verbatim tail), `src/context.test.ts` (5: root-first discovery through nested dirs, AGENTS.md beats CLAUDE.md, ctx wrapping, skills index order and content, frontmatter), `src/prompt.test.ts` (5: fixed-text budget, byte-stability, only the date block changes per day, blocks present, no empty blocks), `src/compact.test.ts` (9: late trigger, tail kept verbatim, previous summary merged, abort is a no-op on the input array, nothing-to-compact cases, tail never starts with an orphaned tool result, generous tail keeps call+result together, overflow detection, Agent-level compaction and abort-during-compaction). bun run check: lint+tsc+test all pass, zero warnings (60 tests).
- Live run against Strata on 8081: 56 tool calls / 56 tool results, all paired, every message with a parentId; `--continue` resumed that log and answered in 2.9s; with `--context-window 30000` the Agent compacted for real ("compacted: 21 messages kept verbatim", summary written with all five sections, view = summary + tail) and answered correctly from the compacted view.
- NOT done (phase 4 bug, found while smoke-testing, deliberately not touched here): `searchTool` with `mode: "files"` always returns "" — `{pattern, path:".", mode:"files"}` finds nothing while the same call with `mode:"content"` returns `notes.txt\n1: hello`. A path that does not exist also returns "" instead of an error, so a model that picks files mode gets no signal at all and repeats the same call until the turn limit. Reproduce with `searchTool.run({pattern:"hello", path:".", mode:"files"}, ctx)` in a dir containing a matching file.
- Assumptions: print mode was the only place `--continue` could live, so it now runs the Agent (tools enabled, activity on stderr) rather than a bare provider call; the TUI and rpc modes remain Phase 8/10. The summary is a `user` message wrapped in `<compacted_summary>` so it is valid for every provider template and detectable when merging. `--context-window` doubles as the compaction trigger knob. `run_end` AgentEvent is still declared but never emitted (pre-existing since Phase 2, left for the TUI).

## Phase 4 fix pass: the search tool stops lying — DONE
Found by driving the tool through the real model on Strata (8081): it repeated one `search` call 50 times and ended in `[limit]`, because the tool returned an empty string. Everything below is fixed in src/tools/search.ts + src/tools/search-backends.ts.
- Empty output no longer means "nothing found": content mode answers `[no matches for \`x\` in <path>]`, files mode answers `[no files matching \`glob\` in <path>]`, and when a plain word is handed to files mode the message says that `pattern` is a glob there and points at `mode "content"`. That single message is what stops the repeat loop. Re-run live: same prompt, the model now uses bash to look, retries with a real glob, and answers correctly instead of burning 50 turns.
- Invalid regex is caught up front (`smartRegex`) so both backends answer identically, and stderr is now drained: `ScanNote.error` carries rg's own message, so a backend failure can never be mistaken for an empty result.
- `path` was concatenated onto the cwd, which mangled absolute paths (`/etc` became `<cwd>//etc`), hid a missing directory as "", and crashed the whole tool with ENOTDIR when pointed at a file. Now `resolve()` (absolute paths and `..` work) plus `ERROR: path not found` / `ERROR: not a directory` before any backend starts.
- The Bun fallback aborted the whole scan on one unreadable file. Unreadable files are skipped now; an unreadable directory ends the scan as a partial result (`ERROR: search failed: scan stopped early: ...`) instead of throwing out of the tool. A spawn that cannot even start is captured the same way.
- Test fixtures leaked: every run left a `.tmp-search-test-<pid>` directory in the repo (107 had piled up). Cleanup is an `afterAll` in search.test.ts and tools.test.ts now, so a failing run still cleans up, and the old junk is gone.
- Verified all three backends give identical output for the whole matrix: rg on PATH, the pinned `~/.kinoko/bin/rg` (checked with rg hidden from PATH, so the download path is finally exercised), and the Bun fallback.
- Tests: search.test.ts 4 -> 7 (empty results per mode and per backend, refusals instead of throws, absolute paths outside the cwd). 62 tests, zero warnings.
- Known limitation, documented not fixed: the Bun fallback stops early on a directory it cannot read, where rg skips it. The spec pins the fallback to `Bun.Glob.scan`, so instead of hand-rolling a walker the scan reports it honestly. Only reachable when searching system directories like /etc.

## Phase 6 (Anthropic provider): SKIPPED on purpose
The spec itself marks it "optional if you only use local models", and nothing in phases 7-10 refers to
it, so the first version ships against Strata only (it speaks the OpenAI wire format, which
`openai-compat` already handles). No placeholder or stub was written for it.
Deferred, for whenever an Anthropic model is actually needed:
- `src/providers/anthropic.ts` (Messages API: content_block_start/delta/stop, message_delta) — just
  another `Provider`, one file, no change to the loop.
- Prompt caching: `cache_control` breakpoints on the system prompt and the last tool definition,
  mapped to the `cacheRead` / `cacheWrite` that `Usage` already has.
- `reasoning_effort` is OpenAI-specific; Claude wants `thinking: {type, budget_tokens}`.
- `max_tokens` is REQUIRED by the Messages API (no server default). Today it is always sent anyway
  because `maxOutputTokens` defaults to 8192, so nothing breaks if this is bolted on later.
- `src/providers/models.json` (per-model contextWindow / supportsCache / reasoning format) is NOT
  Anthropic-specific and would be worth having as soon as a second provider or model appears;
  `contextWindow` is a hand-written config value today.
- Strata also exposes `/v1/messages` (Anthropic format), so a Claude-style endpoint is reachable
  from the same local engine if that is ever handy.

## Phase 7: extension system — DONE
- Done: `src/ext.ts` — a typed event bus plus the loader. Extensions are plain `.ts` files with a default export, imported dynamically from `~/.kinoko/ext` and `<cwd>/.kinoko/ext` (top-level `*.ts`, no subdirectories). All eight events are wired: `session_start`, `context` (chained: each handler sees what the previous returned), `before_provider_request`, `tool_call` (may mutate args in place, or return `{block, reason}`), `tool_result`, `turn_end`, `compact`, `run_end`. A blocked call never runs and its reason becomes the tool result the model reads, reported through the normal `tool_output`/`tool_end` events so a UI closes the row. A throwing handler is logged and skipped; a file that fails to import, has no default export, or throws while starting is skipped and the rest still load.
- `src/loop.ts` emits the events; extension-registered tools are callable like any other (main.ts passes `[...defaultTools(), ...ext.tools()]`). `context` rewrites only the copy sent to the provider — the session log and `agent.messages` keep every message, which is what keeps the prompt byte-stable.
- Shipped in `examples/ext/` (not core): `permission-gate.ts` (a hardline floor for `rm -rf /`, `~`, mkfs, fork bombs and friends that `KINOKO_YOLO=1` can never open, plus a confirm/deny gate for `rm -rf`, `sudo`, `chmod 777`, `dd`, `shutdown`), `plan-mode.ts` (blocks `write` and `edit`, and any bash segment that is not read-only — checked per `&&`/`||`/`;`/`|` segment, with redirection and `tee` treated as writes), `hello.ts` (a tool plus a `/hello` command).
- `src/main.ts` loads extensions before anything else, so a slash command (`-p "/hello kinoko"`) runs without an engine, a config or an API key; an unknown command lists the ones that exist. `tsconfig.json` now includes `examples`, so the shipped extensions are typechecked.
- Tests: `src/ext.test.ts` — 9 tests: load order (user dir first, then project, name-sorted inside each, non-`.ts` ignored), broken extensions skipped with the good ones still loaded, `tool_call` mutating args and blocking (and the blocked tool never running), a throwing handler skipped while the run finishes, a registered tool callable by the agent plus commands reachable, `context` rewriting the request without touching history, and all three shipped extensions installed the way a user installs them — including that `KINOKO_YOLO=1` opens the gate but not the hardline. 71 tests, zero warnings.
- Live: `/hello kinoko` answers with no engine configured; with permission-gate installed the model asked for `chmod 777 /tmp/ext-live/x`, the gate blocked it, the model reported the block instead of claiming success, and nothing was created.
- Assumptions: load order is user extensions first, then project ones, so a project file wins a duplicate command name. `tool_result` handlers may rewrite the output in place (only blocking was specified for `tool_call`). `session_start` is emitted once when the session is opened, not per run. Slash dispatch lives in print mode for now.
- NOT done: the README that `hello.ts` is written for is Phase 10; no TUI wiring for commands or events yet (Phase 8/9).

## Phase 8: TUI foundation — DONE
- Done: `src/tui/term.ts` (raw stdin mode, bracketed paste on, resize events, and a `KeyParser` that is pure and unit-testable: chars, control keys, CSI/SS3 arrows, modified arrows, Alt+Enter as the Shift+Enter a terminal sends, Alt+char, delete/home/end/pagedown, UTF-8 intact), `src/tui/editor.ts` (multiline editor: insert at the cursor, grapheme-aware backspace/delete, line and word movement, ctrl-a/e/k/u/w/p/n, history, `view()` for a wrapped cursor), `src/tui/render.ts` (live region only, differential repaint, 33ms throttle, identical frames are not repainted at all, `printAbove` moves the region out of the way and redraws it below, so the native scrollback is never touched), `src/tui/markdown.ts` (fences dimmed and never inline-formatted, bold, inline code), `src/tui/demo.ts`.
- No alternate screen anywhere, and nothing blocks the event loop: keys are parsed synchronously from stdin data events and the region is repainted from a timer.
- Esc disambiguation: a lone ESC is held back for one frame and only becomes an Esc if nothing follows it, so ESC and Alt+<key> never fight. `Term.pollKeys()` drains it from the render loop.
- Tests: 36 new tests across `term.test.ts`, `editor.test.ts` and `render.test.ts`, covering chunk-split escape sequences, pastes that straddle chunks, wrapping, history, the differential ANSI output, the throttle, and markdown. 107 tests, zero warnings.
- Verified by running the demo: typing stays live for the whole 10s stream (211 frames show the typed line), a submitted prompt is echoed and the editor clears, Esc quits. Four bugs found and fixed on the way: `match(...).length` measured the match ARRAY (1) so ctrl+arrow moved one character; ctrl-u/ctrl-k killed to the buffer edge instead of the line edge; ctrl-k kept the wrong half; and a lone ESC split across chunks was read as ESC + "[".
- Assumptions: Up/Down move the cursor between lines and history is on Ctrl+P/Ctrl+N (readline). Alt+Up/Alt+Down are NOT used by the editor: the editor reports them as `alt-up`/`alt-down` so Phase 9 can wire "pull the queued message back" without the two bindings fighting. Editor history is in-memory only (persisting it is Phase 10's business).
- NOT done, by design: no Agent wiring, no interruption bindings, no queued area, no status line beyond the demo's own header (Phase 9).

## Phase 9: TUI wired to the Agent — DONE
- Done: `src/tui/keys.ts` (the binding table as a pure function of key + {running, editor empty}, so docs/interruption.md is testable on its own), `src/tui/view.ts` (how the live region looks: pure layout, status line, tool blocks, stream overflow, /help text), `src/tui/app.ts` (the App: keys in, Agent events out), `src/main.ts --tui` (raw terminal, 30fps loop, Ctrl-SIGINT as Ctrl-C).
- Every binding from docs/interruption.md is wired and tested: Enter prompts when idle and steers when running; Alt+Enter follows up when running and prompts when idle; Esc aborts while running and does nothing when idle; Ctrl-C is the ladder abort -> clear -> quit; Alt+Up pulls the newest queued message back. Plus Ctrl-D quits on an empty editor, Ctrl-T expands tool output, and /help /model /compact /fork /quit. A leading slash in the editor is a command and never reaches the model.
- Interruption is first class: `dropped` messages come back into the editor joined by newlines with a one-line "Interrupted" marker, and tool blocks that were cut say `aborted` instead of showing a result. Finalized assistant text and finished tool blocks print above the region so the native scrollback keeps them; only the running tool, the streaming tail, the queued area, the editor and the status line stay live.
- The Agent grew what the TUI needed: it now emits `run_end` to its listeners (declared since Phase 2, never fired) and `compactNow()` for /compact.
- Tests: `src/tui/app.test.ts` drives the App with a scripted provider and a keyboard feed (13 tests: abort under 100ms, partial answer kept, steer delivered after the tool batch, follow-up only at the stop, queued messages restored, Alt+Up, the Ctrl-C ladder, status line with usage and cache, tool blocks collapsed and expanded, aborted tool, slash commands, /compact both ways, typing during a stream) and `src/tui/keys.test.ts` covers the binding table (8). 129 tests, zero warnings.
- Bugs found and fixed while wiring: the status line existed but was never rendered; the queued area double-counted (both the App and `queue_change` pushed); an aborted tool printed its synthetic result instead of "aborted"; `Session.setHead` only moved the head after the write, so /fork appeared to do nothing; Enter stopped submitting after the key-table refactor; `#followUp` and Alt+Enter were never wired to a key at all.
- Live: `bun run src/main.ts --tui` against Strata on 8081 accepted a prompt, streamed the answer, and walked the status line from RUNNING to IDLE with real usage (1,214/128,000 tokens); /help, /model, /compact and /quit all ran through the real binary.
- Assumptions: "collapsible tool blocks" is a global Ctrl-T toggle for whether finished blocks print their full output (3 lines + a hint when off); expanding one after it has scrolled into the scrollback is not interactive. Alt+Enter and Shift+Enter are the same bytes in most terminals, so Ctrl-O is the newline key while idle (documented in /help). `run_end` is emitted once per `prompt()`. Editor history is in-memory.
- NOT done: no rpc mode and no packaging/README (Phase 10); /model only reports the model, it does not switch it (no models.json yet); the TUI does not restore an editor draft across restarts.

## Phase 10: modes, README, binary — DONE
- Done: `src/rpc.ts` (JSONL over stdio: `prompt`, `steer`, `follow_up`, `abort`, `get_state` in; the AgentEvent stream plus `ok`/`error` replies out; partial input lines are buffered until complete; bad JSON is answered, never thrown). `src/main.ts` gained `--mode tui|print|rpc`; print mode now runs the full agent loop and exits non-zero when the run was aborted or failed, so a script can tell. `README.md`. `bun run build` = `bun build --compile --outfile kinoko-out/kinoko src/main.ts` (single 81MB ELF, no runtime deps). `.gitignore` so the binary, test fixtures and spills stay out of git.
- One request at a time over rpc too: a second `prompt` while busy is an error naming the alternatives (`use steer or follow_up`), never silently queued. `steer`/`follow_up` without a run are errors, and an empty `id` is echoed back on the reply.
- Tests: `src/rpc.test.ts` (8) — event stream of a whole run, steer + follow_up + abort mid-run with the reply order checked (`started -> steering -> follow up queued -> aborting -> aborted`), a refused second prompt, state reporting, malformed input, the partial-message-before-run_end ordering, and every line out being one complete JSON object even when the answer contains newlines. 137 tests, zero warnings.
- Verified against the compiled binary, not just the source: `-p` answered a fake server and exited 0; SIGINT mid-run aborted in 13ms, printed `[aborted]`, kept the partial answer and exited **1**; rpc mode answered 27 lines with zero invalid JSON, the replies in the order above, and exited 0 when stdin closed.
- Bugs found by that verification: **rpc mode never exited when stdin closed** (no `onClose` wired, so `process.exit` was never reached), and **`run_end` was emitted before the partial `message_end` on abort** — `#emitPartialAssistant` became async in Phase 9 (it appends to the session) and one call site did not await it, so the event a client paints arrived after the run had already closed. Both fixed, both now covered by tests.
- Assumptions: rpc replies are `{type:"ok"|"error", id?, text?, detail?, state?}` and events are wrapped as `{type:"event", event:<AgentEvent>}`, so a client can tell them apart without guessing. Closing stdin ends the process with exit 0. Print mode treats "done" as success and everything else (`aborted`, `error`, `limit`) as non-zero.
- NOT done: `/model` still only reports the model (no models.json yet); no editor-facing rpc client is shipped; the compiled binary is not cross-compiled or signed; editor history is still in-memory.

## TUI layout adjustment — DONE
- Done: the live conversation remains top-aligned and `liveRegion` fills the available terminal height with blank rows before the editor; the editor/status therefore stay at the bottom. App receives terminal height at startup and updates it on resize.
- Test: `src/tui/view.test.ts` verifies the transcript begins at the top and editor/status occupy the final rows. `bun run check` passes (138 tests, zero lint warnings).
- Assumption: the TUI starts at the terminal's current cursor position, as before; viewport filling uses the terminal row count and avoids introducing an alternate screen.

## TUI transcript and cursor fix — DONE
- Fixed renderer cursor bookkeeping: repaints now return to the live region's actual top row from the editor cursor, avoiding a line of scroll for each keypress in a full-height region.
- TUI startup now clears the visible screen and homes the cursor before the first frame, giving the full-height renderer a stable origin instead of inheriting the shell prompt's cursor row.
- Submitted prompts are printed with a gray background, and completed assistant text is preserved in scrollback so exchanges remain visible in order.
- Tests: renderer full-height repaint regression and app prompt/answer visibility. `bun run check` passes (140 tests, zero lint warnings).

## TUI repaint and message visibility follow-up — DONE
- Done: the renderer does not emit a newline after its last live row, so a full-height repaint cannot scroll the terminal while typing. Small viewports retain the cursor, editor and status rows, trimming only transient stream/queue rows; wrapped editor rows are now used for layout.
- Done: every submitted prompt, including a steer or follow-up, is printed into scrollback with a light-blue treatment before the model response.
- Tests: short-viewport layout and no-final-newline renderer regression. `bun run check` passes (141 tests, zero lint warnings).
- Assumption: a terminal shorter than two rows cannot show both an editor and status line, so it retains the existing unconstrained rendering fallback.

## TUI terminal-width fix — DONE
- Fixed: editor wrapping had incorrectly used the model context-window width instead of terminal columns. The App now receives columns on startup and resize, wraps the editor to that width, and clips every live row before the terminal's final column so emulator autowrap cannot scroll the region.
- Build: rebuilt `kinoko-out/kinoko` and installed it at `~/.local/bin/kinoko`, which is the `kinoko` command on this machine.
- Tests: `bun run check` passes (142 tests, zero lint warnings).

## TUI visual follow-up — DONE
- Done: the editor/status anchor at the lower edge of the active upper two-thirds of the terminal, leaving a quiet lower third like Pi while the transcript stays above it. User messages keep their light-blue foreground without a background.
- Done: the agent now emits `thinking_delta`; streamed and finalized reasoning is rendered dim and italic, never mixed with answer text or sent back to a provider.
- Build: rebuilt and installed `~/.local/bin/kinoko`. `bun run check` passes (143 tests, zero lint warnings).

## TUI Pi-style startup and padding — DONE
- Done: startup prints the version, discovered context/skills/extensions, and a one-line prompt above the live region. These rows remain reserved across terminal resizes.
- Done: a one-column global horizontal padding applies to live and finalized transcript output. Finalized transcript rows wrap to the current terminal width instead of overflowing or requiring fullscreen to read.
- Build: rebuilt and installed `~/.local/bin/kinoko`. `bun run check` passes (144 tests, zero lint warnings).

## TUI fixed-bottom input — DONE
- Fixed: live rendering uses absolute terminal row positioning and the actual terminal height. The live region fills from below the startup panel through the bottom row; editor/status stay anchored there while transcript content scrolls above them.
- Styled `[Capabilities]` in orange and reserved two blank rows before the editor.
- Build: rebuilt and installed `~/.local/bin/kinoko`. `bun run check` passes (144 tests, zero lint warnings).

## TUI adaptive input anchor correction — DONE
- Corrected: the live region now begins immediately below the startup panel and starts at half the available terminal height. It grows with transcript content until it fills the viewport; only then the editor/status sit at the terminal's bottom edge.
- The renderer positions the adaptive region from a stable top row, rather than bottom-anchoring a short initial frame.
- Build: rebuilt and installed `~/.local/bin/kinoko`. `bun run check` passes (145 tests, zero lint warnings).
- Prompt visibility restored in the live transcript using light-blue foreground only; echoes no longer go through `printAbove`, where absolute repaint covered them.

## TUI completed answer persistence — DONE
- Fixed: finalized assistant text is retained in the live transcript instead of being printed under the absolute-positioned region and then erased by its repaint. User prompts remain blue; assistant answers remain visible after run completion.
- Tests: final app frame retains the answer and user styling has no background. `bun run check` passes (146 tests); binary rebuilt and installed.
- Fixed thinking persistence too: finalized reasoning is kept as its own transcript entry and stays dim/italic after the run ends.

## CLI reference doc — DONE
- Added `kinoko-cli.md`: tables of invocations, flags, RPC commands and dev commands, read off `src/main.ts`, `src/rpc.ts`, `src/ext.ts`. No code touched.
- `bun run check` passes (147 tests, zero warnings).
- Assumption: "cli commands" = modes, flags, RPC commands and npm scripts; the five agent tools are already tabulated in README.md and were not duplicated.

## TUI transcript width fix — DONE
- Fixed: long transcript rows (user prompts, assistant/stream text, queued, markers) are wrapped to the full terminal width with ANSI colors preserved across split rows, instead of being clipped with a "…" ellipsis. `clipAnsi` no longer cuts rows that already fit (a trailing reset used to trigger the ellipsis), remaining only as a safety net for truly overlong rows. The idle hint wraps instead of clipping too; editor rows and cursor math are untouched (the editor was already wrapped by the App).
- Tests: two new tests in `src/tui/view.test.ts` (full-width wrap with no ellipsis + style-preserving `wrapAnsi`). `bun run check` passes (149 tests, zero warnings).
- Build: rebuilt `kinoko-out/kinoko` and installed it at `~/.local/bin/kinoko`.

## TUI flowing layout (no fixed input, no filler gap) — DONE
- Fixed: the live region no longer pads with blank rows or reserves a bottom third, so the input sits right below the startup panel (the panel's own trailing lines are the only gap, max 2) and flows downward as the conversation grows. Only when content + editor + status exceed the viewport is the head trimmed, which pins the editor/status to the bottom while the conversation scrolls above. Cursor-visibility trimming for oversized editors is kept.
- Tests: reworked the two viewport layout tests in `src/tui/view.test.ts` (flowing start, tail-keep on short viewport) plus a new overflow-pinning test. `bun run check` passes (150 tests, zero warnings).
- Build: rebuilt `kinoko-out/kinoko` and installed it at `~/.local/bin/kinoko` (via `mv`, the old binary was running).

## TUI scrollback keeps every chat — DONE
- Fixed: transcript head rows trimmed by the viewport are no longer lost. `liveRegion` now reports them as `dropped` (transcript rows only — streaming/queued/tool rows are never reported, so the stream-spill path in `#finishMessage` can never double-print), and the App moves them to the native scrollback with `printAbove` exactly once, in order, tracked by a running count over the append-only transcript prefix. Scrolling up now reaches every prompt and answer.
- Tests: two `view.test.ts` cases (dropped head, tail rows never dropped) and an `app.test.ts` case driving two prompts in a 6-row viewport (first exchange reachable in scrollback, exactly once, correct order). `bun run check` passes (153 tests, zero warnings).
- Assumptions: a terminal resize rewraps rows, so the flushed-row count can misalign by a few boundary lines after a width change (resize-only cosmetic artifact, never a loss). `session.test.ts` #5 ("--continue picks the newest") failed once in a full run and passed alone and on rerun: pre-existing mtime-resolution flake, untouched by this change.
- Build: rebuilt `kinoko-out/kinoko` and installed it at `~/.local/bin/kinoko`.

## TUI tool block styling — DONE
- Tool head: name in bold yellow, then what the call acts on in bold white instead of its JSON (`read`/`write`/`edit` → path, `bash` → cmd, `search` → pattern [in path], unknown/extension tools → JSON fallback). Same style on the running line.
- Tool output sits on a full-width light band: green on success, red on failure. Failure = `ERROR:` result, a non-zero exit or a timeout.
- `bash` now appends `[exit code N]` on a non-zero exit (visible to the model too; stdout/stderr stay merged in order).
- Tests: view.test.ts (summary, head colors, failure detection, bands) and tools.test.ts (exit code). 174 pass, tsc clean. Lint: the pre-existing test-file warnings/errors from commit 43bd5f2 remain (render/order/view tests), untouched.
- Build: rebuilt and installed `~/.local/bin/kinoko`.

## TUI tool block styling, round 2 — DONE
- The band now covers the whole tool block (head, output and the "more lines" hint), not just the output; resets inside a row re-open the band so it never breaks mid-row.
- Softer tints, one step off a dark background: ok `rgb(30,44,38)`, error `rgb(50,30,36)`.
- The tool dot is yellow like the tool name (yellow = tool), also on the running line.
- Tests: band covers every row and pads to the width, yellow dot. 175 pass, tsc clean, view.ts lints clean.
- Build: rebuilt and installed `~/.local/bin/kinoko`.

## TUI input restyle + Anthropic provider (phase 6) — DONE
- Tool blocks: one band row of padding above and below.
- Input: a blank row separates the transcript from the input; the editor sits between two dim rules with a drawn block cursor (inverse cell; the terminal cursor stays hidden), the hint is a placeholder under the cursor. Under the bottom rule: `~/Projects/kinoko (master)` from `src/tui/place.ts` (reads `.git/HEAD`, worktree-aware, no git process; refreshed after every run), then the status line. Tiny viewports drop the rules first.
- Split `src/tui/view.ts` (was 402 lines): `style.ts` (ANSI palette, wrap/clip) and `tools.ts` (tool head/summary/band). Startup region now uses the full terminal height (rows - 1) like resize; dropped the deprecated App options.
- Phase 6: `src/providers/anthropic.ts` (raw fetch + SSE, tool calls only when JSON complete, none on abort/truncation/refusal), cache breakpoints on system + last tool + top-level automatic caching for the conversation, adaptive thinking with summarized display, `reasoningEffort` -> `output_config.effort` (`off` -> `low`), server-side refusal fallback (`fallbacks: "default"`) where the model has one. `src/providers/models.json`: context window, max output, cache, reasoning, fallback, prices. Config `provider: "openai-compat" | "anthropic"` (+ `--provider`); anthropic fills baseUrl/apiKey($ANTHROPIC_API_KEY)/contextWindow/maxOutputTokens(min(model max, 64k)) when left at defaults.
- Signed thinking must go back unchanged: new `Message.replay` (opaque, set from a `replay` stream event) is sent as-is; compaction and the session view strip it from the kept tail (keep-tail compaction would otherwise be rejected).
- Fixed: `maxCost` was never enforced (cost was never accumulated); the loop now adds `usage.cost`.
- Lint: fixed the pre-existing test-file errors/warnings from 43bd5f2. `bun run check` passes (191 tests, zero warnings).
- Assumptions: a global `~/.kinoko/config.json` written for a local model still applies its `maxOutputTokens`/`contextWindow` to anthropic (override per run with flags). Haiku 5.5 cache-read price is an estimate (0.1x input).
- Build: rebuilt and installed `~/.local/bin/kinoko`.

## TUI polish: amanita rules, no prompt mark, separate tool bands, widths, Shift+Enter — DONE
- No "> " prompt mark in the editor or in the transcript echo; just the block cursor (user text stays light blue).
- Input rules in amanita red `rgb(232,36,36)`; an interruption marker uses the same red, after a blank row (other markers keep inverse).
- Tools run one at a time (the loop is sequential); each tool block now gets a blank row above it, so consecutive calls are separate bands.
- Band overflow fixed: width math is per terminal column (`style.ts` `charWidth`: wide emoji/CJK = 2, combining = 0, code-point iteration); tabs in transcript blocks expand to 4 spaces.
- Shift+Enter inserts a newline: Term pushes the kitty keyboard protocol (level 1) on start and pops it on stop; `CSI 13;2u` is Shift+Enter, and the parser understands CSI-u Esc/Ctrl/Alt keys. Ctrl+J (`\n`) is a newline everywhere; legacy `ESC CR` is Alt+Enter (follow-up/submit) as the spec says.
- `bun run check` passes (197 tests, zero warnings). Rebuilt and installed `~/.local/bin/kinoko`.

## TUI: Shift+Enter for real, no placeholder, coloured path — DONE
- Root cause: Zed (like VS Code/iTerm set up by Claude Code) sends ESC+CR for Shift+Enter (`~/.config/zed/keymap.json`), and kinoko read ESC+CR as Alt+Enter (submit/follow-up). ESC+CR is now a newline, as in Claude Code and pi; kitty `CSI 13;2u` too. Alt+Enter (follow-up) remains available where the kitty protocol tells it apart (`CSI 13;3u`).
- The idle placeholder is gone: an empty editor shows only the block cursor. Dropped the now-unused `editorEmpty` from RegionInput.
- Place line: path in amanita cream `rgb(238,222,186)`, branch in amanita red.
- Tests: app-level ESC+CR / CSI 13;2u newline test, place colours. `bun run check` passes (199 tests). Rebuilt and installed `~/.local/bin/kinoko`.

## TUI: token count fix, intro spacing, status margin — DONE
- Fixed the context counter: the status line summed every request's `input`, but each request re-sends the whole conversation, so a turn with N tool rounds counted the history N times (and showed more than the context window). It now shows the latest request's prompt + output; the cache hit rate stays a session total (cached / sent).
- The startup panel goes through `App.intro()` (printAbove), so the first prompt gets the usual blank row after "Kinoko can inspect…".
- Status line starts level with the rows above (`IDLE` / inverse `RUNNING`, no leading space).
- Checked the fixed prompt cost: system prompt ~990 tokens + tool schemas ~630 (chars/4). Note: `read` is the only tool without an output budget (up to 2000 lines per call).
- Tests: tool-round context test, intro spacing, status margin. `bun run check` passes (201 tests). Rebuilt and installed `~/.local/bin/kinoko`.

## feat/parser: markdown + code panes — DONE (branch feat/parser)
- `markdown.ts` rewritten: headings (h1 amanita red, h2 cream, rest bold), bullets (red •), numbers, task boxes (☐/☑), nesting, block quotes (│ bar, italic), horizontal rules, tables, fenced code, and nested inline spans (`code`, **bold**, *italic*/_italic_ at word boundaries, ~~strike~~, [links](url), escapes). A span re-opens its parent's style after its reset (bold around `code` stays bold). Rows are wrapped by word (`style.ts` `wrapWords`) with hanging indents for lists/quotes.
- `table.ts`: box-drawn grid, bold cream header, `:---:` alignment; shrinks the widest columns and word-wraps cells to fit the terminal.
- `code.ts` + `highlight.ts`: fenced code as an editor pane — own background, language label, line-number gutter, soft-wrapped long lines with empty gutter; data-driven tokenizer (C-like/TS/JS/JSON/Go/Rust…, Python, shell, SQL, YAML/TOML, diff) for keywords, strings, numbers, comments (block comments carry across lines), calls, types, JSON keys, shell variables. Foreground-only escapes, so the pane background never breaks.
- Streaming: `splitStable` never cuts inside a fence or between table rows, so those render whole (widths, numbering, highlighting); while streaming the region shows their tail, and on close the whole block goes to the scrollback. Removed the now-dead `inFence` plumbing. `formatBlock` keeps a one-entry cache (the region asked for the same block every frame; a 500-line pane costs ~9 ms).
- Tests: new `markdown.test.ts` (inline, blocks, tables, panes, highlighting) and splitStable cases. `bun run check` passes (216 tests). Rebuilt and installed `~/.local/bin/kinoko`.
- Note: `app.ts` (484) and `term.ts` (326) were already over the ~300-line guideline before this branch.
- Round 2: a padding row above the language label; long code lines soft-wrap at token boundaries (after space , ; ( [ {, before a dot) with a hanging indent two columns past the line's own indentation, instead of cutting mid-identifier; only an unbreakable run is cut by column. The language label is the full name ("TypeScript", not "ts") in the top-right corner with a two-column margin. Template literals colour `${expr}` as code (red `${ }`), and shell double-quoted strings colour `$VAR`. 219 tests pass; rebuilt and installed.
