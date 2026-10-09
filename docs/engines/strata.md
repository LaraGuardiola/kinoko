# Strata (local inference engine) with Kinoko

Strata exposes the same kind of API as llama.cpp, so Kinoko needs NO new provider: the existing
`openai-compat` provider is the integration. Only configuration and a few details change.

## Config (`~/.kinoko/config.json` or `./.kinoko/config.json`)
{ "baseUrl": "http://127.0.0.1:8081/v1", "apiKey": "any", "model": "qwen3.8-flash-next-coder-iq1_m-120k",
  "contextWindow": 122880, "reasoningEffort": "low", "maxOutputTokens": 32768 }
- `maxOutputTokens` counts thinking too. This model drafts whole files in its thinking, so 4096 or
  8192 cuts most turns before the tool call (finish_reason "length"). 32768 leaves room; Strata itself
  has no cap (`n_predict: -1`).
- `reasoningEffort` reaches the chat template (`reasoning_effort`): no value means **xhigh**, `low`
  only adds a "keep your thinking brief" hint the model may ignore, `medium` adds nothing, and `off`
  is the only hard switch (no thinking at all).
- The template preserves thinking (`preserve_thinking` defaults to true), so Kinoko sends each
  assistant turn's thinking back as `reasoning_content`; without it every earlier turn renders an
  empty `<think></think>`.
- Strata accepts any API key and any model name. This machine runs it on port 8081 (see
  `examples/config.strata.json`).
- `contextWindow` MUST match the context size chosen in Strata's setup (the installer asks for it).
  The engine reports it: `GET /v1/models` -> `data[0].meta.n_ctx` (122880 here).
- Other endpoints exist if ever needed: `/v1/messages` (Anthropic format), `/v1/responses`.
- Remote use: Strata must be started with `--host 0.0.0.0 --api-key <secret>`; always set a key.

## Behaviors that shape Kinoko's design (from the Strata README)
- ONE REQUEST AT A TIME by default (others wait; `"parallel": 2` is optional and slows each answer).
  => Kinoko never sends two provider requests at once (compaction included), and an aborted request
  must really free the engine, otherwise the next request queues behind a "zombie" generation.
- The FIRST message of a chat is read in full (~1 min per 30,000 tokens); follow-up messages start in
  seconds. => the prompt prefix is precious: keep history append-only and byte-stable.
- Thinking is selectable: off / low / medium / high ("reasoning effort"). Off is fastest.
- Typical speed on a 12 GB card: ~50-90 tokens/s writing, ~1,600-2,600 tokens/s reading the prompt.
  The first token can take many seconds on a long prompt: NEVER use short request timeouts.

## Probe results (full report: `strata-probe.txt`)
`bun run scripts/probe-engine.ts http://127.0.0.1:8081/v1 <model>` answers the five unknowns. On this
machine all five are OK:
1. Thinking arrives in `delta.reasoning_content` and is never inside `content`; no `<think>` tags.
2. Tool calls stream in fragments and the arguments concatenate into valid JSON.
3. **Abort frees the engine.** After cutting a generation the next request's first delta arrived in
   1.1s, so there is no zombie generation to work around: NO startup warning, NO capped
   `maxOutputTokens` and NO abort hack. (Had this said SUSPECT, the only sanctioned response was a
   startup warning plus a capped `maxOutputTokens` plus a note in this file.)
4. The prompt prefix is reused (cold 13.1s vs warm 0.42s for the same ~6,000-token prefix).
5. A `usage` chunk with `prompt_tokens_details.cached_tokens` is sent.

Wire detail worth remembering: the engine sends an empty first `delta` and `: keep-alive` comment lines
right away, so "time to first byte" is not "time to first token". Kinoko's `SseParser` ignores
non-`data:` lines, which is why those comments are harmless.