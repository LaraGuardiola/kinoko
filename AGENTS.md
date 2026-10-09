# Kinoko: agent rules

Kinoko ("mushroom") is a tiny, fast, hackable coding-agent harness (CLI/TUI) in TypeScript on Bun.
Pi-style: small core, five tools (read, write, edit, bash, search), everything else is an extension.

## How we work
- The phased build is finished (`docs/phases/` is history, not a to-do list). We are now polishing and
  finishing the project: bug fixes, rough edges, small features the user asks for.
- Before starting: read this file and the latest entries of `docs/PROGRESS.md`.
- Do only what was asked. If something was not asked for, do not build it.
- Every change gets its own branch off main (`feat/...`, `fix/...`), even a small one. Commit there;
  merge into main (`--no-ff`, "Merge branch '<name>': <what>") only when the user says so, then
  push main (`git push origin main`).
- After finishing: run the checks below and append a short entry to `docs/PROGRESS.md`
  (what changed, what is NOT done, assumptions). If the change touches runtime behavior, rebuild and
  reinstall the binary (`bun run build && install -m 755 kinoko-out/kinoko ~/.local/bin/kinoko`):
  the `kinoko` command on this machine is that binary, not the source.
- Pick sensible defaults and state assumptions in one line instead of stopping to ask.

## Hard rules
- Bun + strict TypeScript. ZERO runtime dependencies.
  devDependencies allowed ONLY: typescript, @types/bun, oxlint.
- No agent frameworks, no AI SDKs, no TUI libraries.
- No RAG/embeddings, no MCP, no multi-agent, no sandbox in the core.
- Small: each file under ~300 lines, one responsibility per file, core ~2000 lines total.
  Prefer deleting code over adding it.
- Policy lives in config and extensions, not in prompt prose. The system prompt stays under 40 lines.
- INTERRUPTION IS FIRST-CLASS (see `docs/interruption.md`): every async operation accepts and honors
  an AbortSignal, and nothing may block the event loop (no spawnSync, no heavy synchronous loops),
  so the user can always cut the model.

## Checks (all must pass with zero warnings before you report)
- `bun run lint`      (oxlint, with --deny-warnings)
- `bunx tsc --noEmit`
- `bun test`
`bun run check` runs all three. oxlint is the only linter: add no other linter or formatter.
Never disable a rule just to make code pass; fix the code. A disable comment needs a one-line reason.

## Conventions
- Tests live in `src/testing/`, mirroring `src/` (`src/tui/app.ts` → `src/testing/tui/app.test.ts`),
  as `*.test.ts` using `bun:test`. The one exception is `examples/ext/`: each example ships with its test.
  Use a fake Provider and fake tools for loop tests, and a fake SSE server (`Bun.serve`) for providers.
- A tool error becomes a tool message "ERROR: ...". It never crashes the loop.
- User-level files live in `~/.kinoko/` (config, sessions, ext, bin). Project-level in `./.kinoko/`.

## Architecture map
src/main.ts        CLI entry, modes (tui | print | rpc)     src/args.ts  command-line parsing
src/types.ts       shared contracts (Message, Provider, Tool, StreamEvent...)
src/loop.ts        Agent class: linear loop + abort/steer/followUp
src/providers/     one file per wire protocol + models.json (data, not code)
src/tools/         read, write, edit, bash, search, budget, tracker, registry
src/context.ts     AGENTS.md / skills discovery      src/prompt.ts  system prompt builder
src/session.ts     append-only JSONL (id + parentId)  src/compact.ts threshold compaction
src/ext.ts         extension loader + event bus       src/config.ts  layered config
src/tui/           raw-ANSI renderer, editor, markdown-lite, slash menu, side panel (plan + git changes)
src/testing/       the tests, same layout as src/ (src/testing/tui/app.test.ts tests src/tui/app.ts)
