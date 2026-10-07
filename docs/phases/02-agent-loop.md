# Phase 2: the agent loop with abort, steer and follow-up

Read first: AGENTS.md, docs/interruption.md (the "Agent semantics" section is the spec), src/types.ts.

## Create `src/loop.ts` exporting class Agent (no TUI, no real tools in this phase)
```ts
constructor(opts: { provider: Provider; model: string; system: string; tools: Tool[]; maxTurns: number; maxCost: number })
state: "idle" | "running"
messages: Message[]
prompt(text: string): Promise<RunResult>  // starts a run; rejects if already running
steer(text: string): void
followUp(text: string): void
abort(): void
on(listener: (e: AgentEvent) => void): () => void
// AgentEvent = run_start | message_delta | message_end | tool_start | tool_output | tool_end | queue_change | run_end
// RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[] }
```

The loop is a plain linear `while`:
call provider -> stream text -> collect tool calls ->
 - no tool calls: check steer queue, then followUp queue (non-empty: inject as a user message and continue; empty: finish)
 - tool calls: execute them, append tool results, check the steer queue, repeat.
Guards: maxTurns, maxCost, and a cap of 3 consecutive malformed tool calls.

Implement EVERY numbered rule 1-8 of docs/interruption.md and write one test per rule.

## Acceptance
Tests with a fake Provider (async generator with controllable delays) and fake tools (one that sleeps 30s
but honors the signal). Must include: "abort leaves the agent idle in <100ms", "tool call / tool result
pairing is always valid after an abort", "steer has priority over follow-up", "dropped messages are
returned on abort". `bun run check` passes.
