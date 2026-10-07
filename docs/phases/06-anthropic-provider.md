# Phase 6: Anthropic provider and prompt caching (optional if you only use local models)

Read first: AGENTS.md, docs/PROGRESS.md, src/types.ts, src/providers/openai-compat.ts.

## Create
- `src/providers/anthropic.ts`: same Provider interface, raw fetch to the Messages API and a
  hand-written SSE parser (content_block_start/delta/stop, message_delta). Same rules as before:
  tool_call events only when the JSON args are complete; no partial calls on abort or truncation;
  honor req.signal.
- Place cache_control breakpoints on the system prompt and on the last tool definition. Map usage to
  cacheRead / cacheWrite.
- Config: add `provider: "openai-compat" | "anthropic"`.
- `src/providers/models.json` (data, not code): per model contextWindow, supportsCache, reasoning format.

## Acceptance (fake SSE server)
Streaming text, split tool-call JSON, abort mid-stream, usage mapping. `bun run check` passes.
