# Phase 4b: local engine compatibility (Strata / llama.cpp style engines)

Do this after Phase 4 and BEFORE Phase 5.
Read first: AGENTS.md, docs/PROGRESS.md, docs/engines/strata.md, docs/interruption.md,
src/types.ts, src/config.ts, src/providers/openai-compat.ts, src/loop.ts.

Before coding, the human runs `bun run scripts/probe-engine.ts` against the engine and pastes the report
into docs/engines/strata-probe.txt. Use that report to decide the details below; if it contradicts this
spec, follow the report and note it in docs/PROGRESS.md.

## Implement
- Config: add `reasoningEffort?: "off"|"low"|"medium"|"high"` and `maxOutputTokens` (default 8192).
  Send `reasoning_effort` and `max_tokens` in the request body only when set.
- Types: add StreamEvent `{ type: "thinking"; delta: string }`. Message gets optional `thinking?: string`
  (for display and session logs ONLY). Thinking text is NEVER sent back to the provider in later requests.
- openai-compat parsing:
  - `delta.reasoning_content` and `delta.reasoning` -> `thinking` events, never mixed into `text`.
  - Fallback: if `<think>` appears in `delta.content`, split `<think>...</think>` into thinking events with a
    tiny state machine that works across chunk boundaries. Enable it only after a tag is first seen.
  - Always request `stream_options: { include_usage: true }`. Map prompt_tokens / completion_tokens, and
    `prompt_tokens_details.cached_tokens` to cacheRead when present.
- NO request timeouts, no idle timeouts: the first byte may take over a minute on a long prompt.
  Only the AbortSignal ends a request.
- Loop: emit `request_start` and `first_token` AgentEvents (with timestamps) so the TUI can show
  "reading prompt..." and the time to first token later. The Agent never has two provider requests in
  flight at once; assert this in a test.
- Abort must close the HTTP connection immediately (fetch signal). If the probe reports "SUSPECT: server
  kept generating after abort", log a warning at startup, keep `maxOutputTokens` capped, and add a note in
  docs/engines/strata.md. Do not try to work around it with hacks.
- Save the example config for Strata (see docs/engines/strata.md) as `examples/config.strata.json`.

## Acceptance (fake SSE server)
1. reasoning_content deltas become thinking events and do not appear in text.
2. `<think>` split across chunk boundaries is handled; text stays clean.
3. reasoning_effort and max_tokens appear in the request body only when configured.
4. A server that sends its first byte after 3s does not time out.
5. usage chunk (with and without cached tokens) maps correctly.
6. Two prompts in a row never overlap provider requests (including a compaction-style call).
`bun run check` passes.
