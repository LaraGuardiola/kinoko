# Phase 1: skeleton, shared types, provider, print mode, lint

Read first: AGENTS.md, docs/PROGRESS.md.

## Create
- `package.json` (type: module). Scripts:
  - "start": "bun run src/main.ts"
  - "lint": "oxlint --deny-warnings"
  - "test": "bun test"
  - "check": "oxlint --deny-warnings && tsc --noEmit && bun test"
  devDependencies: typescript, @types/bun, oxlint.
- `tsconfig.json` (strict, Bun types).
- `.oxlintrc.json`: category "correctness" = error, "suspicious" and "perf" = warn,
  rule `typescript/no-explicit-any` = warn. Example starting point (adjust if oxlint rejects it):
  { "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
    "rules": { "typescript/no-explicit-any": "warn" } }
  The `any` in Tool.run args is the only allowed exception (inline disable with a reason).

- `src/types.ts`, with exactly these contracts (add fields only if strictly needed):

```ts
export type Role = "system" | "user" | "assistant" | "tool";
export interface ToolCall { id: string; name: string; args: unknown }
export interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number }
export type StopReason = "end" | "tool_use" | "length" | "aborted" | "error";
export interface Message {
  id: string; parentId?: string; role: Role; content: string;
  toolCalls?: ToolCall[]; toolCallId?: string; // toolCallId only on role "tool"
  stop?: StopReason; usage?: Usage;
}
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall } // emitted ONLY when its JSON args are complete
  | { type: "done"; stop: StopReason; usage?: Usage }
  | { type: "error"; message: string };
export interface ToolSpec { name: string; description: string; schema: object }
export interface ProviderRequest { model: string; system: string; messages: Message[]; tools: ToolSpec[]; signal: AbortSignal }
export interface Provider { stream(req: ProviderRequest): AsyncIterable<StreamEvent> }
export interface ToolContext { signal: AbortSignal; cwd: string; onOutput?: (chunk: string) => void }
export interface Tool extends ToolSpec { readOnly?: boolean; run(args: any, ctx: ToolContext): Promise<string> }
```

- `src/config.ts`: defaults < ~/.kinoko/config.json < ./.kinoko/config.json < CLI flags.
  Fields: baseUrl, apiKey, model, maxTurns (50), maxCost (5), contextWindow.
- `src/providers/openai-compat.ts`: raw fetch to {baseUrl}/chat/completions with stream:true and a
  hand-written SSE parser (no libs). Accumulate streamed tool-call argument fragments and parse the JSON
  only at the end of the stream. If the stream is cut or aborted, DO NOT emit partial tool calls; emit
  done with stop "aborted" or "length". Pass req.signal to fetch.
- `src/main.ts`: `bun run src/main.ts -p "prompt"` prints the streamed answer to stdout.
  No loop and no tools yet.

## Acceptance (tests with a fake SSE server via Bun.serve)
1. Text streams in order.
2. A tool call split across 3 SSE chunks arrives as ONE tool_call event.
3. Aborting mid-stream stops iteration within 100ms and emits no partial tool_call.
4. `bun run check` passes with zero warnings.
