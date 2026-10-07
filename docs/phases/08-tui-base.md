# Phase 8: TUI foundation (render, editor, streaming), no interruption wiring yet

Read first: AGENTS.md, docs/PROGRESS.md, docs/interruption.md, src/loop.ts.

## Create `src/tui/{term,render,editor,markdown}.ts`
Hand-rolled raw ANSI. NO alternate screen (keep native terminal scrollback).
- term.ts: raw stdin mode; key parser (Enter, Shift/Alt+Enter, Esc, Ctrl-C, Ctrl-D, arrows, Alt+Up,
  backspace, paste); resize events.
- render.ts: print finalized content above; keep a small "live region" at the bottom (streaming text,
  tool blocks, queued messages, editor, status line) and re-render ONLY that region with differential
  updates, throttled to ~30fps.
- editor.ts: multiline line editor with history (up/down) and cursor movement.
- markdown.ts: light rendering only: code fences, bold, inline code.
- The editor must keep accepting keystrokes while a run is streaming. Nothing here may block the event loop.

## Acceptance
Unit tests for the key parser and the editor. A manual demo `bun run src/tui/demo.ts` that streams fake
text for 10s while you can keep typing in the editor. `bun run check` passes.
