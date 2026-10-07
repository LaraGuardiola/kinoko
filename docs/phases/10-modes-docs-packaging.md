# Phase 10: print and rpc modes, README, binary

Read first: AGENTS.md, docs/PROGRESS.md, docs/interruption.md, src/main.ts.

## Implement
- `kinoko -p "prompt"`: non-interactive, runs the full agent loop, prints the final answer. SIGINT
  aborts cleanly and exits non-zero.
- `kinoko --mode rpc`: JSONL over stdio. Commands in: prompt, steer, follow_up, abort, get_state.
  Events out: the AgentEvent stream, one JSON object per line. abort/steer/follow_up must work while a
  run is in progress.
- README.md: what Kinoko is, the philosophy (small core, five tools, everything else is an extension),
  the five tools, key bindings, how to write an extension (use examples/ext/hello.ts), config layers.
- package.json script "build" using `bun build --compile` to produce a single binary.

## Acceptance
An rpc test that starts a run, sends steer and abort over stdin and checks the event order; the compiled
binary starts and runs `-p` against a fake server. `bun run check` passes.
