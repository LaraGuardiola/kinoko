# Kinoko CLI

Everything below is read off `src/main.ts` (modes and flags), `src/rpc.ts` (RPC commands) and
`src/ext.ts` (slash commands).

## Invocations

| command | what it does |
| --- | --- |
| `kinoko` | interactive mode (the TUI). Chosen when there is a prompt on stdin and no mode was asked for. |
| `kinoko --tui` | ask for the interactive mode explicitly: raw-ANSI terminal in, live region out. Takes no prompt argument. |
| `kinoko -p "prompt"` / `--print "prompt"` | non-interactive: run the full agent loop once, final answer on stdout, tool activity on stderr, non-zero exit if the run was aborted or failed. |
| `kinoko --mode rpc` | JSONL on stdin, JSONL on stdout, for editors and scripts. |
| `kinoko "some prompt"` | bare positional prompt; with no TTY it runs as print mode, otherwise it is ignored with a note. |
| `kinoko --mode tui\|print\|rpc` | set the mode by name instead of by flag. |
| `kinoko /name args` | run an extension slash command and print its result, then exit. Works without an engine. |

## Flags

Kebab-case and camelCase both work. Unknown keys are dropped, not applied.

| flag | what it does |
| --- | --- |
| `--base-url <url>` | provider endpoint (config key `baseUrl`). |
| `--api-key <key>` | API key; falls back to `$KINOKO_API_KEY`, then to config files. Missing means exit 1. |
| `--model <name>` | model id to send to the provider. |
| `--max-turns <n>` | cap on agent turns. |
| `--max-cost <n>` | stop the run past this cost. |
| `--context-window <n>` | context window in tokens; drives when compaction fires (`contextWindow - 16384`). |
| `--max-output-tokens <n>` | completion budget per request. |
| `--reasoning-effort <level>` | reasoning effort passed to the provider. |
| `--continue`, `-c` | resume the latest session for this project instead of starting a new one (print mode only). |

## RPC commands (`--mode rpc`)

One object per line in, one per line out. `steer`, `follow_up` and `abort` work mid-run.

| command | what it does |
| --- | --- |
| `{"type":"prompt","text":"..."}` | start a run. Refused if one is already running. |
| `{"type":"steer","text":"..."}` | steer the running turn. |
| `{"type":"follow_up","text":"..."}` | queue a message delivered when the model would stop. |
| `{"type":"abort"}` | cut the running run. |
| `{"type":"get_state"}` | reply with `running`, `model`, `messages`. |

## Development commands

| command | what it does |
| --- | --- |
| `bun run start -- --tui` | run from source without building. |
| `bun run build` | compile to `kinoko-out/kinoko`. |
| `bun run lint` | `oxlint --deny-warnings`. |
| `bun test` | run the `*.test.ts` files. |
| `bun run check` | lint + `tsc --noEmit` + test, all three must pass clean. |
| `bun run src/tui/demo.ts` | watch the region repaint while the editor stays live. |
| `bun run scripts/probe-engine.ts` | report what your local engine can do. |
