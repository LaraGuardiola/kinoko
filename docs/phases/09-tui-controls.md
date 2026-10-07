# Phase 9: wire the TUI to the Agent with first-class interruption controls

Read first: AGENTS.md, docs/PROGRESS.md, docs/interruption.md ("Key bindings" is the spec), src/loop.ts, src/tui/*.

## Implement
- All key bindings in docs/interruption.md, and document them in /help and the README.
- A "queued" area above the editor, kept in sync with queue_change events, tagged [steer] / [follow-up].
- On run_end with reason "aborted": put `dropped` back into the editor and show a one-line
  "Interrupted" marker.
- Collapsible tool blocks; aborted tools show "aborted".
- Status line: model, tokens used / window, cost, cache hit %, and a clear RUNNING / IDLE indicator.
- Slash commands: /help, /model, /compact, /fork (moves the session head), /quit.

## Acceptance
An integration test driving the TUI with a scripted fake provider and a fake keyboard feed:
abort within 100ms; steer delivered after the tool batch; follow-up delivered only at stop; queued
messages restored after abort. `bun run check` passes.
