# Progress

One entry per finished change: what is done, what is NOT done, assumptions.
Phases 1-10 built the core; everything after them is polish.

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
- Lowercase built-in types (string, number, boolean, i32, str…) are coloured as types.

## fix/llm-behaviour: overthinking, loops, runs that stop on their own — DONE (branch fix/llm-behaviour)
- Diagnosis (flappy-bird/voxel session `nu1cktkorwfi`, 440 entries): 16 replies ended `stop=length` at exactly 4096 output tokens with no text and no tool call (the model drafts whole files inside its thinking; `~/.kinoko/config.json` has `maxOutputTokens: 4096`). The loop treated `length` as the end of the run, so the user had to type "continue"; the next request had the same context minus the thinking, so the model re-derived the same plan and was cut again (10 times in a row at entries 372–391). Two more runs ended at exactly 50 turns (default `maxTurns`), silently. One reply repeated a line 36 times. Compaction never ran because the run peaked at ~86k tokens, under the 106k trigger (122880 − 16384).
- Effort: probed Strata directly. `reasoning_effort` does reach the template; unset means xhigh, `low` is only a soft hint, `off` disables thinking. So the setting works but only `off` is a hard limit.
- Loop: a reply cut by the output limit (or by the repeat guard) with no tool call gets a nudge user message and the run continues, up to 3 in a row (`MAX_NUDGES`), then stops with a reason. New `src/guard.ts`: `RepeatGuard` cuts a reply mid-stream when one line (≥24 chars) repeats 8 times (its looping thinking is not kept); `CallGuard` notes on the tool result when the same call returns the same output 3 times, and stops the run at 10. Each request gets its own AbortController (`AbortSignal.any` with the run's), so a guard cuts one reply without aborting the run.
- `RunResult.detail` / `run_end.detail`: the TUI shows "Stopped — turn limit (500)" etc. for `limit`/`error`; print mode prints it. Default `maxTurns` 50 → 500.
- openai-compat: assistant thinking is sent back as `reasoning_content` (templates that preserve thinking rendered an empty `<think>` for every past turn); a reply with `finish_reason: "length"` never yields tool calls, even if their JSON parses (a truncated `write` must not run). `ProviderRequest.effort` overrides the configured effort; compaction asks for `off` so a reasoning model cannot spend the whole output limit thinking and return no summary. `messageTokens` now counts thinking, since it is sent.
- Docs: `docs/engines/strata.md` and `examples/config.strata.json` recommend `maxOutputTokens: 32768`.
- Tests: `guard.test.ts`, `loop-guards.test.ts` (nudge, nudge cap, cut looping thinking, repeated call), two openai-compat cases. `bun run check` passes (229 tests). `session.test.ts` #5 flaked once more (known mtime flake), passed on rerun.
- NOT done: the user's `~/.kinoko/config.json` still says `maxOutputTokens: 4096` (user file, not touched). `loop.ts` is now 422 lines (was 393, already over the guideline).

## fix/llm-behaviour, round 2: tool review — DONE
- Session check: the model's "the environment rewrites my files" was a hallucination; every write landed byte for byte and the edit error showed the real text. But the tools had real bugs feeding that distrust:
- `edit`: the overlap check compared each range with itself, so EVERY call with 2+ edits failed with "edits overlap" (9 times in the voxel session; the model fell back to heredocs/base64 and blamed the write tool). Fixed; the test only covered a real overlap, now also two separate edits.
- `edit`: exact `indexOf` first; the per-char NFKC normalization runs only when an old string does not match byte for byte. "not found" no longer echoes the whole `old`; it shows the file window most like it (each line of `old` votes for the start), ready to copy. "ambiguous" gives the line numbers.
- Loop: tools ran read-only first, so `[write a, read a]` read the old `a`. They now run in the order called (they never ran in parallel anyway). `docs/interruption.md` item 7 updated.
- `tracker`: no more synchronous whole-file reads (`readFileSync` blocked the event loop on every write/edit). Same mtime = unchanged; the hash is only checked when the mtime moved, using the text the caller already read.
- `read`: output capped at ~40k chars (~10k tokens) at a line boundary, with `[lines a-b of N; continue with offset=…]` whenever the file goes on.
- `bash`: stdin is closed (a command waiting for input used to hang forever), utf8 decoding per stream (multi-byte chars split across chunks were mangled), default timeout 300 s.
- `write`: says which argument is missing; reports lines and chars.
- `bun run check` passes (231 tests). src net −12 lines.

## fix/llm-behaviour, round 3: "the harness rewrites my files" — DONE
- Traced session `e58094f8` (66 turns, 9 of them suspecting the environment): every write landed exactly as sent and every read matched; Strata does render past tool-call arguments into the prompt (measured: longer args → more prompt tokens). The model sees its own calls and even spots its own typos in them (`color: 'POWERUPS.magnet'`). The cause is the model: what it emits differs from what it meant (1.75-bit quant), and when it reads the file back it does not recognise its own output. Its `_probe.ts` "test" wrote `MARKER = 42`, read `MARKER = 42`, and concluded the harness rewrites files. One trigger came from the harness: a read with `offset: 30` showed only a slice of a file, which the model took for the whole file.
- `read`: every partial view is labelled (`[lines a-b of N]`, plus `continue with offset=` when more follows).
- System prompt: one line, files change only through the tools or the user, so when a file differs from memory, trust the tool result.
- `edit`: "missing path (string)", like write.
- Tool errors fell from 13 (voxel session, 214 turns) to 2 in this one (66 turns).
- `bun run check` passes (231 tests; the session #5 mtime flake fired once).

## fix/llm-behaviour, round 4: a run that ended "done" mid-task — DONE
- Session `a01968e1`: the last reply (#65) never closed its thinking. It looped `"strict": true,` 129 times, then wrote its tool call (`</parameter></function></tool_call>`) inside the thinking. Strata returned it all as reasoning: no text, no call, `stop=end`, so the loop took it as "done". The repeat guard missed it: the line is 15 chars and only lines ≥ 24 chars were counted.
- `RepeatGuard`: also trips on 12 identical non-empty lines in a row, whatever their length.
- Loop: a reply with no text and no tool call is nudged (`NUDGE_EMPTY`: a call inside the thinking does not run; close it, then call or say you are done), under the same `MAX_NUDGES` cap.
- `bash`: the parameter is `command`, the name models expect (the model sent `command` and got "cmd must be a string"); `cmd` is still accepted. `examples/ext/permission-gate.ts` and `plan-mode.ts` read both names. Reading only `cmd` would have let a `command` through the gate unchecked. Tested.
- Still open: `~/.kinoko/config.json` has `maxOutputTokens: 4096` (reply #10 cut at exactly 4096).
- `bun run check` passes (233 tests).

## fix/llm-behaviour, round 5: tool results as the only version of a file — DONE
- Audit of session `2fdb6bee`: replaying every write/edit in memory gives exactly the files on disk (13/13 identical; 11 skipped because bash touched them); every comparable read matched its write. The tools are right. The model said it itself: "the files on disk are different from what I drafted in my thinking". It holds two versions of each file in context (the draft in its thinking, the real call) and trusts the draft.
- openai-compat: only the newest assistant turn sends its thinking back (`reasoning_content`), so a cut reply can still continue; older thinking (old drafts) is no longer sent. It also costs far less context. `historyTokens` counts only that one thinking.
- `edit`: the result shows the edited lines as they are now on disk (2 lines of context, at most 30 per edit, `…` between distant edits), so the real text sits right after the action.
- `bun run check` passes (233 tests).

## fix/llm-behaviour, round 6: thinking copied verbatim; same error under different flags — DONE
- Session `58ae57a5`: the thinking of #29 is a byte-for-byte copy of #27's, which was the newest thinking and so the one round 5 sent back. A small model copies its last reasoning, and that makes the loop. Thinking now goes back only when the newest reply was cut by the output limit (`stop: "length"`), the one case where continuing from it helps.
- The same session ran 7 different `bun build` commands (only the flags changed) that all returned the identical "Could not resolve" error. `CallGuard.failures` counts consecutive identical failures (`ERROR:`, `[exit code N]`, or an `error` word) of one tool whatever its args; from the 3rd it appends a note: the arguments being changed are not the cause, re-read the error itself.
- Seen, not changed: after the user's steer, the model sometimes reads tool results as the user speaking ("The user is asking about the --config flag"). Strata's chat template renders tool results inside user turns, so pi gets the same rendering.
- `~/.kinoko/config.json`: `maxOutputTokens` 4096 → 32768 (with the user's permission).
- `bun run check` passes (234 tests).

## fix/llm-behaviour, round 7: a hard thinking budget, real token counts for compaction — DONE
- Thinking: `reasoningEffort` already reaches the template (the "keep your thinking brief" sentence), but per Strata's own docs it is "an instruction, not a hard token limit", and this model ignores it. Strata caps thinking with `reasoning_budget_tokens` (its config defaults to 4096, the cut the user saw every turn; a request's value wins). Measured on the live engine with effort high: no budget gave 21,966 chars of thinking that degenerated into a loop and used all 6,000 tokens with no answer; a budget of 400 ended the thinking with "I have thought about this long enough" and the model answered. New config `thinkingBudget` (`--thinking-budget`) → openai-compat `reasoning_budget_tokens`, sent only when set (OpenAI rejects unknown fields). User config: 2048.
- Compaction: chars/4 ran 16-26% short of Strata's real prompt counts (no system prompt or tool schemas, and the tokenizer's ratio), and the gap grew. With the 122,880 window it would trigger at ~130k real tokens, after the server had already overflowed. `contextTokens` takes the server's usage (prompt + reply) of the newest reply and estimates only what came after. A compacted tail drops its `usage` (compact.ts and session.ts view) so it cannot re-trigger compaction at once.
- The context counter was right: the session peaked at 19,764 tokens (16% of the window), so compaction correctly never ran. Thinking from earlier turns is not resent, so it is not in the prompt.
- Tests polluted the real `~/.kinoko/sessions`: `app.test.ts` created sessions without `home`, one new directory per run. Fixed (`home: ROOT`); removed 152 test-only session directories, kept the 11 real ones.
- `bun run check` passes (236 tests).

## TUI: context %, generated tokens, thinking level on the input rule — DONE
- Status line: `19,764/122,880 tok 16%` (how full the window is) and `61,873 generated`, a session total of every reply's output, thinking included. Thinking is not resent, so it costs time, not context; the two numbers together show both.
- The rule above the editor carries the thinking level near its right end, bold cream: `──────── LOW · 2048 ──` (`thinkingLabel` in config.ts: effort uppercased, `DEFAULT` when unset, `OFF`, plus the budget when one is set). A plain rule when the terminal is too narrow for it.
- Tests: status percent and generated total (app.test), labelled rule (view.test), `thinkingLabel` (new config.test). `bun run check` passes (238 tests).
- Next (asked for later): changing the level from the TUI.

## Repeat note for writes — DONE
- Live session `33effaae`: the model wrote byte-identical content to `spawning.ts` four times (#122-#128) while its plan said "fix the bugs". The call guard fired at the third, but its note ("got this exact result every time") read to the model as "the write tool keeps returning the same content". For a tool that changes files (not `readOnly`) the note now says the arguments were byte-identical, the file already holds exactly that content, and fixing it needs different arguments. Read-only tools keep the old note.
- `bun run check` passes (239 tests).

## TUI: steer echo on delivery, plain run state, two-tone name — DONE
- A steer (Enter while running) or follow-up (Alt+Enter) no longer prints its blue user line when typed: it shows only in the queued area (`[steer]` / `[follow-up]`) until the loop hands it to the model. New AgentEvent `delivered` (loop `#deliver`: leave the queue, append the user message, emit), and the App echoes it then, so it lands where the model actually read it.
- Status line: `RUNNING` without the inverse background.
- Startup panel: `kinoko` in amanita red, the version in cream.
- Tests: app.test (no echo before delivery, exactly one after; no inverse in the status), order.test updated to the new order. `bun run check` passes (239 tests).

## examples/ext/web.ts: web search and fetch, no API key — DONE
- Two read-only tools. `web_search(query, max?)` scrapes the HTML result pages of Brave Search, then DuckDuckGo, then Bing, and returns the first that answers with results: numbered title, real URL (DuckDuckGo's `uddg=` and Bing's `u=a1<base64url>` redirects decoded), snippet clipped to 300 chars. `web_fetch(url, offset?)` turns a page into readable text (`<main>`/`<article>` when present; scripts, styles, nav, header, footer dropped; headings `#`, list items `-`, entities decoded), JSON and text as-is, binaries refused, 12,000 chars per page with `continue with offset=`.
- Probed live: DuckDuckGo's HTML page answers 202 (its bot check) after a few queries, and the lite page at once; Bing without cookies matches only the first word of the query (and localizes "bun" to blood urea nitrogen); Mojeek and Startpage refuse; Brave gave the most relevant results, so it goes first.
- Every request honors the run's AbortSignal, plus a 20 s cap so a silent server cannot hold a run.
- Tests (`examples/ext/web.test.ts`, no network): the three parsers on fixtures, entity decoding, HTML to text, `web_fetch` against a local `Bun.serve` (page, paging, JSON, binary, 404, non-http, abort), the engine fallback past a 202, and the tool registration. `bun run check` passes (250 tests).
- Not installed for the user yet (it would change the kinoko vs pi comparison); `cp examples/ext/web.ts ~/.kinoko/ext/` switches it on.

## TUI: the place line follows git during a run — DONE
- The cwd/branch line was re-read only when a run ended, so a `git init` (or a checkout) made early in a long run did not show until the end, which looked like it needed a restart. It is now re-read after every tool call too: two small file reads, no git process.
- Test (app.test 8e): a tool "inits a repo" mid-run; the branch shows while the run is still going. Verified the test fails without the fix. The harness gained a `place` option. `bun run check` passes (251 tests).

## TUI: a tool call shows at once, its bullet pulsing until the result — DONE
- Before, nothing showed while the model wrote a tool call (a `write` with a whole file can take minutes): the call only appeared once its args were complete and the tool was running, as a static line.
- New StreamEvent / AgentEvent `tool_pending { name }`: openai-compat emits it on the first `tool_calls` chunk that carries the name, anthropic on `content_block_start` of a `tool_use`. The App shows `● name …` at once and keeps it until `tool_start` (then the running line, args known) and `tool_end` (the static result block, as before). A call cut off before it completes (no tool calls on the message) drops the line.
- While a call is pending or running the bullet fades between dim amber rgb(70,58,22) and its resting yellow rgb(255,215,95) on a cosine, 1.2 s per cycle in 12 steps (`pulseLevel` / `pulseDot` in tools.ts), so the 33 ms render timer repaints about 10 times a second and only while a tool is in progress.
- Tests: both providers announce the name first; pulse steps and colours; running line colour with and without a pulse; app.test 8f shows the line before the call exists (fails without the feature). `bun run check` passes (254 tests).

## Sessions: resume by id, per directory — DONE
- On exit (Ctrl+C on an empty editor, Ctrl+D, /quit) the TUI prints `resume this session with  kinoko --session <id>`. A session nothing was said in is deleted instead (no file, no hint), so the per-directory session list holds only real conversations.
- `--session <id>` (exact id, a unique prefix, or the pasted `<id>.jsonl`) is looked up in this directory's sessions only (`findSession` in session.ts); an unknown id, or one from another directory, exits with "no session … sessions are kept per directory". `--continue` now works in the TUI too (it was print mode only) and takes the newest one.
- Resuming in the TUI prints the conversation again (`src/tui/replay.ts`, `App.replay`): your messages, the answers and each tool call with its result, as the live view shows them; thinking and the loop's own `[kinoko]` nudges are left out, a compaction shows as a one-line note. The context counter comes back from the last reply's usage.
- Tests: session.test 7-8 (find by id/prefix/pasted name, not across directories; `empty`), replay.test. End to end with the built binary in a pseudo-terminal: resume by 8-char prefix shows the conversation and 920 tok, quitting prints the command; an empty session leaves no file; wrong or foreign ids exit 1 with the message. `bun run check` passes (257 tests).
- Next (asked for later): a small session picker menu.

## Flaky session.test #5 — FIXED
- "--continue picks the newest session" failed now and then under the full suite. Cause: Linux stamps mtimes from a coarse clock (a few ms per tick), so the two sessions' writes, microseconds apart, could share one mtime and "newest" became a tie decided by readdir order. The test's 10 ms pause sat after both writes, where it does nothing; a 25 ms pause now sits between them. 15/15 isolated runs and 5/5 full `bun run check` runs pass. (It also slipped through the previous commit: that check's exit code was hidden by a pipe.)

## Resume keeps the prompt's date — DONE
- A resumed ~53k-token session read its whole prompt once (first request: 53,315 in, 0 cached), then went back to the cache (next: 53,310 of 54,111 cached). Expected: the engine reuses only a byte-identical prefix, and here the prefix had changed (the `web.ts` extension was installed after the session started, and tool schemas render first) or the engine no longer held it.
- One avoidable cause fixed: the system prompt's date was today's at every start, so a session resumed on a later day changed its very first line and always re-read everything. The date now comes from the session's creation (`meta.created`), resolved before the prompt is built: a new session gets today, a resumed one keeps its own.
- `bun run check` passes (257 tests).

## Resume keeps read-before-change — DONE
- After resuming, the model got "you must read this file before changing it" for `hud.ts`, a file it had just written: the read-before-change tracker lives in memory, so a restarted kinoko forgot every file the session had read or written.
- `src/tools/restore.ts` (`restoreTracker`, called in main.ts on resume): from the session's messages, the last content the model saw of each file (a write's content, each later edit replayed byte for byte, a whole read with its line numbers stripped; partial reads, failed calls and unknown bases teach nothing). A file is marked read only if the disk still holds exactly that (the trailing newline aside, since a read cannot show it); anything changed since still needs a read.
- On the real resumed session: 44 files touched, 38 trusted again, `hud.ts` among them.
- Tests: restore.test (write, write then edit, read with blank lines, changed on disk, partial read, missing file, failed calls, edit on an unknown base). `bun run check` passes (259 tests).

## TUI: the pending tool line shows its path as soon as it is written — DONE
- The pulsing line only had the tool's name while the model wrote the call. Strata streams a call's JSON args piece by piece (string params character by character), so the path or command can show long before the call completes.
- `src/providers/partial-args.ts` (`ArgsWatcher`): fed the arg pieces, reports every complete `"key": "string"` field when a piece completes a new one (escapes undone, numbers ignored). It only rescans on a piece containing a quote, from where the last complete field ended. Both providers emit `tool_pending { name, args }` again on each new complete field; the loop forwards `args`; the App shows `toolSummary(name, args)` without its JSON fallback, so a call with nothing useful yet shows just its name. `toolSummary` also names `web_search`'s query and `web_fetch`'s url.
- A model that writes `content` before `path` gets its path shown only at the end: what is shown is what the model has written so far.
- Tests: partial-args.test (char by char, escaped quotes), both providers announce the path after the name, app.test 8f shows `● bash make all …` before the call exists (10/10 runs). `bun run check` passes (261 tests).

## feat/tui-slash-menu: the "/" menu — DONE (branch feat/tui-slash-menu)
- Typing "/" opens a menu between the rule under the input and the place line, in the [Capabilities] orange (`src/tui/menu.ts`: state, scrolling window of 8 rows, rows; `src/tui/menu-pages.ts`: what it offers). The root lists `thinking`, `models`, `session`, then the existing `compact`, `fork`, `help`, `quit`; typing after the slash narrows it. ↑/↓ move (wrapping), Enter opens or runs, Esc on a page goes back to the root, Esc on the root closes it and empties the input. While the menu is open it takes Esc first, so it never aborts a run. A slash command with an argument (`/model now`) closes the root and runs as typed.
- thinking: profiles off / low (2,048) / medium (4,096) / high (8,192) / extreme (no cap), the one matching the config marked. A pick applies from the next request (`Agent.setThinking`, `ProviderRequest.budget`; budget 0 = no cap is sent) and relabels the input rule. A budget is sent only when the config sets one (the engine takes it); elsewhere the effort alone.
- models: asks the provider (`Provider.models`: openai-compat `GET /models`, anthropic the models.json names), shows "asking the engine…" until it answers; a pick applies from the next request (`Agent.setModel`) and updates the status line.
- session: a table of the file, id, start, messages (user / assistant; the loop's nudges are not the user), tool calls and results, context and tokens.
- Tests: menu.test (state, filter, rows, scrolling, labels, session table), app.test slash menu (placement, filter, thinking and model picks reaching the next request, Esc levels, session table, Esc never aborts a run). End to end with the built binary in a pseudo-terminal: root, Thinking with `low` marked, Models listing Strata's real model. `bun run check` passes (275 tests).
- Debt: `src/tui/app.ts` is 641 lines (527 before this branch); the menu glue that needs the App's state stays in it.
- Picks last for the session; persisting them to the config is not done.

## feat/tui-slash-menu: /help tables, adding models — DONE
- `/help` prints two tables in the session table's style: keys, and the menu (built from the menu's own list, so it cannot fall behind). The old plain-text HELP is gone.
- `/models` lists the endpoint's own models, then models saved before (labelled by host; the configured model is always one of them, so there is a way back), then `+ add model`. Adding takes three steps inside the menu: endpoint (a scheme added when missing), API key (shown as dots; Enter skips it), then one of the models the endpoint lists (`listModels`: `GET /models`, with `meta.n_ctx` as the context window when the engine gives it), or the model id typed by hand when it lists none. The pick is switched to (`Agent.setProvider` with its context window, `setModel`) and saved to `~/.kinoko/models.json` (0600, it holds keys; the same endpoint and model replace the old entry). Esc at any step goes back to the root.
- Menu: a new input page kind (typing, backspace, Enter submits, secret fields as dots). A list pick that opens another page keeps the menu open. `Menu.refresh(from, to)` replaces a loading page only while it is still on screen; matching by title failed when the title changed on load.
- Tests: models-menu.test (endpoint parsing, page order and dedupe, saved file and its 0600 mode), app.test adding a model (discovered and typed-by-hand paths, key dots, Esc back to the root, the next request reaching the new endpoint and model). End to end with the built binary against the real Strata, in a scratch HOME: the endpoint lists its model with 122,880 tokens of context and the entry is saved 0600. `bun run check` passes (281 tests).

## feat/tui-slash-menu: removing saved models — DONE
- On `/models`, Del (or Backspace) on a saved model arms it (its description turns red: "Del again to remove"), a second press removes it from `~/.kinoko/models.json` (`removeModel`) and the page redraws in place; moving the selection disarms. The configured model (from config.json) is not removable here (`ModelsHost.fixed`), so there is always one to go back to. The page's last row says so when anything is removable.
- Menu: list pages may carry `remove` and a `hint`; items may be `removable`; `Menu.arm` holds the armed item until the selection moves or the page changes.
- Tests: removeModel, removable flags and the hint (models-menu.test), the two-press flow with a fixed entry ignoring Del, disarm on move, Backspace as Del, the page staying open (app.test). `bun run check` passes (283 tests).

## feat/tui-slash-menu: say when an endpoint does not answer — DONE
- Adding a model at an endpoint where nothing was running went straight to "type the model id" (that is how a wrong port and a made-up id ended up saved). The id step now tells the two cases apart: an endpoint that answered with no list ("did not list its models"), and one that did not answer at all ("Nothing answered at host: is its server running? Esc to go back, or type the model id anyway").
- Tests: both hints (app.test). `bun run check` passes (284 tests).

## feat/tui-slash-menu: each model's own context window — DONE
- Switching to a model on llama.cpp kept Strata's 122,880 as the window: only `meta.n_ctx` (Strata) was read. A window too large lets the prompt overflow before compaction triggers. `listModels` now reads it wherever the server puts it: Strata's `meta.n_ctx`, llama.cpp router mode's launch args (`--ctx-size N` / `-c N`), a single-model llama.cpp server's `/props` (`default_generation_settings.n_ctx`). Never `n_ctx_train` (the training size, not what the server allocated). Live: the user's router on 8086 reports 65,536 for each of its three models.
- Picks: a known window is applied on every pick, also within the same endpoint (it was only applied when the endpoint changed). A model picked without one (typed by hand, or served by the engine in use) asks its endpoint, applies the answer, and saves it on the entry; if the endpoint never says, the marker says the window is unknown and which one stands. `Agent.setContextWindow`.
- Tests: the three server styles and n_ctx_train ignored (openai-compat.test), a saved model learning and keeping its window (app.test). `bun run check` passes (286 tests).

## feat/update-folder-structure: tests in src/testing/ — DONE (branch feat/update-folder-structure)
- The 28 test files moved from next to the code to `src/testing/`, mirroring `src/` (`src/tui/app.ts` → `src/testing/tui/app.test.ts`), with `git mv` so each keeps its history. Their relative imports were rewritten by resolving each one from the old place and re-expressing it from the new one; nothing else in them depended on their location (the paths they use are data or `process.cwd()`-based).
- `examples/ext/web.test.ts` stays next to its example: an example is copied to `~/.kinoko/ext/` on its own, and its test travels with it.
- AGENTS.md: the test-location rule and the architecture map say so.
- `bun run check` passes (286 tests, the same count as before the move).

## Unique skills and extensions; out of the phases — DONE
- Run from `$HOME`, the project dirs (`<cwd>/.agents/skills`, `<cwd>/.kinoko/ext`) are the user dirs, so every skill and extension was listed twice. `uniqueDirs` (context.ts) dedupes the scanned dirs by real path (symlinks included), and skills are unique by name, a project skill shadowing a home one. Same-named extensions in different dirs still both load (different files, different code).
- AGENTS.md: the phased build is over; the workflow is now polish, with a rebuild of `~/.local/bin/kinoko` after runtime changes (the user saw the old duplicates because the installed binary predated the fix). Phase references dropped from `docs/interruption.md` and `docs/engines/strata.md`; the stale root `PROGRESS.md` (an early phase-1 copy of this file) removed.
- Tests: cwd == home for skills and extensions, project skill shadowing (context.test, ext.test). `bun run check` passes (288 tests). Rebuilt and installed the binary.

## Keypad Enter acts as Enter — DONE
- With the kitty protocol on, keypad keys arrive with their own codes (KP_Enter is `CSI 57414u`, Shift+KP_Enter `CSI 57414;2u`), in the private use area, and were typed as that character. `kittyKey` now maps KP_0..KP_Separator (57399-57416) to their main-block twin, so the keypad Enter submits / newlines like Enter, and other private-use functional keys (F13+, media) type nothing. `ESC O M` (application keypad Enter) is Enter too.
- Tests: term.test 6a. `bun run check` passes (289 tests). Rebuilt and installed the binary.

## feat/paste-images: images as [Image #N] — DONE (branch feat/paste-images)
- `Message.images` (`{ mime, data }`, base64), user messages only. The Agent takes them on `prompt`, `steer` and `followUp` (the queues carry them; queue events and dropped messages stay text). openai-compat sends a text part plus `image_url` data URLs; Anthropic sends base64 image blocks before the text. Sessions store them as part of the message, so a resume keeps them. Compaction counts ~1,600 tokens per image; the summary transcript stays text.
- TUI (`src/tui/images.ts`): Ctrl-V reads the clipboard (`wl-paste` on Wayland, `xclip` on X11; types listed first, 5 s timeout, killed on abort). A paste that is one image path (dropped file: quoted, backslashed, `file://`, `~`) attaches that file; a path to nothing stays text; an empty paste reads the clipboard. The type is sniffed from the bytes (PNG, JPEG, GIF, WebP), max 3.75 MB (Anthropic's 5 MB of base64). Each gets `[Image #N]` in the input; numbers only grow and continue after a resumed session's images. On submit, the placeholders still in the text pick the images, so deleting one drops its image, and queued messages handed back after an abort keep theirs. A failure shows as the marker ("Image not attached: ...").
- NOT done: images in print and rpc modes; showing the image itself in the terminal.
- The user's Strata model is text-only (`input_modalities: ["text"]`); it answers an image with a clear error ("started without the vision encoder"), which kinoko shows as the run's error. Checked live with a clipboard PNG.
- Tests: images.test (registry, sniffing, paths, files, clipboard tools with a fake runner), app.test (Ctrl-V in both encodings, a failed read, a dropped file), loop, both providers' wire format, session resume, term (Ctrl-V). `bun run check` passes (301 tests). Rebuilt and installed the binary from this branch.
