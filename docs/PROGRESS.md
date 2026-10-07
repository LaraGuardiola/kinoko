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
- NOT done: search-backends.ts is ~670 lines (over the ~300-line guideline); spec names only these two files, so no third file was invented.

## Phase 4b: local engine compatibility (Strata / llama.cpp style) — DONE except the probe branch
- Done: config `reasoningEffort` ("off"|"low"|"medium"|"high") + `maxOutputTokens` (default 8192) with `--reasoning-effort` / `--max-output-tokens` flags; `reasoning_effort` / `max_tokens` go into the body only when the option is set. `StreamEvent {type:"thinking"}` + `Message.thinking` (display and session logs only, never sent back). openai-compat maps `delta.reasoning_content` / `delta.reasoning` to thinking (never mixed into text), always sends `stream_options.include_usage`, maps prompt_tokens/completion_tokens and `prompt_tokens_details.cached_tokens` to cacheRead. `<think>` fallback lives in src/providers/think-split.ts (moved out to keep openai-compat.ts under 300 lines): state machine across chunk boundaries, armed only once a tag is first seen, so plain content streams straight through. No request and no idle timeouts anywhere in src/ — only the AbortSignal ends a request, and it reaches `fetch`, so abort closes the HTTP connection immediately. Loop emits `request_start` + `first_token` AgentEvents with epoch timestamps. examples/config.strata.json matches docs/engines/strata.md.
- Fixed: scripts/probe-engine.ts did not run at all (duplicate `blank()`, undefined `line()`, dead vars, inverted prefix-reuse comparison) and its lint errors broke `bun run check`; it now runs and prints OK/SUSPECT per check.
- Tests: src/providers/engine-compat.test.ts — acceptance 1-5 against a Bun.serve fake SSE server (reasoning fields never leak into text; `<think>` split inside both tags across chunks with clean text; the splitter stays disarmed until a tag appears; reasoning_effort/max_tokens only when configured; first byte after 3s does not time out; usage chunk with and without cached tokens). src/loop.test.ts 10-11: two prompts plus a mid-run extra request never overlap (peak in-flight 1; that mid-run request is the path Phase 5 compaction will use) and request_start/first_token bracket a request. bun run check: lint+tsc+test all pass, zero warnings (35 tests).
- NOT done: docs/engines/strata-probe.txt does not exist — no engine is reachable from this machine (nothing listens on 127.0.0.1:8080), so the report the spec asks for could not be produced. Therefore the "SUSPECT: server kept generating after abort" branch (startup warning, capped maxOutputTokens, note in docs/engines/strata.md) is NOT implemented: without the report it is unknown whether it applies, and inventing a config flag for it would be the hack the spec forbids. Run `bun run scripts/probe-engine.ts` against a live engine, paste the report, and that branch is the only remaining work.
- Assumptions: since maxOutputTokens defaults to 8192, max_tokens is always sent; "only when set" is honoured at the provider level, i.e. `openaiCompat()` built without the option sends neither key. The unknown thinking field is covered both ways: delta-field mapping plus the `<think>` fallback, so either probe answer parses.
