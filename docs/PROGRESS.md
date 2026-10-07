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
