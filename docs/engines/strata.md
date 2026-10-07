# Strata (local inference engine) with Kinoko

Strata exposes the same kind of API as llama.cpp, so Kinoko needs NO new provider: the existing
`openai-compat` provider (Phase 1) is the integration. Only configuration and a few details change.

## Config (`~/.kinoko/config.json` or `./.kinoko/config.json`)
{ "baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "any", "model": "any",
  "contextWindow": 131072, "reasoningEffort": "low", "maxOutputTokens": 8192 }
- Strata accepts any API key and any model name. Port 8080 by default.
- `contextWindow` MUST match the context size chosen in Strata's setup (the installer asks for it).
- Other endpoints exist if ever needed: `/v1/messages` (Anthropic format), `/v1/responses`.
- Remote use: Strata must be started with `--host 0.0.0.0 --api-key <secret>`; always set a key.

## Behaviors that shape Kinoko's design (from the Strata README)
- ONE REQUEST AT A TIME by default (others wait; `"parallel": 2` is optional and slows each answer).
  => Kinoko never sends two provider requests at once (compaction included), and an aborted request
  must really free the engine, otherwise the next request queues behind a "zombie" generation.
- The FIRST message of a chat is read in full (~1 min per 30,000 tokens); follow-up messages start in
  seconds. => the prompt prefix is precious: keep history append-only and byte-stable (see Phase 5).
- Thinking is selectable: off / low / medium / high ("reasoning effort"). Off is fastest.
- Typical speed on a 12 GB card: ~50-90 tokens/s writing, ~1,600-2,600 tokens/s reading the prompt.
  The first token can take many seconds on a long prompt: NEVER use short request timeouts.

## Unknowns: run `bun run scripts/probe-engine.ts` and read the report
1. Which delta field carries thinking (`reasoning_content`, `reasoning`, or `<think>` inside content).
2. Whether streamed tool calls arrive in fragments and parse as valid JSON.
3. Whether aborting the HTTP request stops the generation (step 4 must say "OK").
4. Whether the prompt prefix is reused between requests (step 5 must say "OK").
5. Whether a `usage` chunk is sent (with cached-token details or not).
