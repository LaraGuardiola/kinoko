# Progress log
Append one entry per finished phase: what is done, what is NOT done, assumptions.

(no phases done yet)

## Phase 1 — skeleton, types, provider, print mode

**Done**
- `package.json` (type: module, scripts start/lint/test/check), `tsconfig.json` (strict + Bun types,
  `noUncheckedIndexedAccess`), `.oxlintrc.json`.
- `src/types.ts`: exact contracts from the spec. Only `Tool.run` uses `any` (inline disable, reason given).
- `src/config.ts`: defaults < `~/.kinoko/config.json` < `./.kinoko/config.json` < CLI flags. Unknown keys and
  wrong-typed values are dropped. `apiKey` also falls back to `$KINOKO_API_KEY`.
- `src/providers/openai-compat.ts`: raw `fetch` to `{baseUrl}/chat/completions`, hand-written SSE parser
  (`SseParser`), tool-call arg fragments accumulated by index and JSON-parsed only after the stream closes.
  Pending calls are dropped on abort/socket death. `req.signal` goes to `fetch`.
- `src/main.ts`: print mode only, `-p/--print "prompt"`, streams text to stdout, SIGINT aborts the stream.
- `src/providers/openai-compat.test.ts`: fake SSE server via `Bun.serve`. 4 tests: text order, one
  tool_call from 3 chunks, abort within 100ms with no partial tool_call, pre-aborted signal.

**NOT done** (later phases): agent loop, tools, sessions, compaction, TUI, extensions, models.json,
rpc mode, cost accounting.

**Assumptions**
- Flags accept both kebab and camel (`--base-url` / `--baseUrl`); a bare positional arg also works as the prompt.
- `docs/phases/` and `docs/interruption.md` do not exist yet, so this entry went into the repo-root
  `PROGRESS.md` (AGENTS.md points at `docs/PROGRESS.md`).
- `stop` for a completed stream with tool calls is `tool_use`; `finish_reason: "length"` maps to `length`.
- Usage is requested via `stream_options.include_usage` but left uncosted until a later phase.