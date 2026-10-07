# Phase 7: extension system

Read first: AGENTS.md, docs/PROGRESS.md, src/loop.ts, src/tools/registry.ts.

## Create `src/ext.ts`
Extensions are plain .ts files loaded with dynamic import() from ~/.kinoko/ext and ./.kinoko/ext.
Each has `export default function (k: Kinoko) { ... }`.
Kinoko API: k.on(event, handler), k.registerTool(tool), k.registerCommand(name, handler).
Typed events: session_start, context (may rewrite messages before a provider call),
before_provider_request, tool_call (handler may mutate args or return { block: true, reason }),
tool_result, turn_end, compact, run_end.
A blocked tool call returns the reason to the model as the tool result. Handlers receive the
AbortSignal where relevant. A handler that throws is logged and skipped, never crashes the loop.

## Ship in `examples/ext/` (NOT in core)
- permission-gate.ts: regex confirm/deny for rm -rf, sudo, chmod 777, with a hardline floor that cannot
  be disabled by a yolo flag.
- plan-mode.ts: blocks write, edit and mutating bash.
- hello.ts: a 15-line example for the README.

## Acceptance
Load order; tool_call mutate and block; a throwing handler is skipped; a registered tool is callable by
the agent. `bun run check` passes.
