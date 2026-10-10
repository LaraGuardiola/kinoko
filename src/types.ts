export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export type StopReason = "end" | "tool_use" | "length" | "aborted" | "error";

/** An image the user attached: raw bytes as base64, and their media type (image/png...). */
export interface Image {
  mime: string;
  data: string;
}

export interface Message {
  id: string;
  parentId?: string;
  role: Role;
  content: string;
  // Shown, logged, and sent back where the wire has a field for it (openai-compat `reasoning_content`:
  // chat templates that preserve thinking render it into the prompt). Anthropic uses `replay` instead.
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string; // toolCallId only on role "tool"
  images?: Image[]; // only on role "user"; the text refers to them as [Image #N]
  stop?: StopReason;
  usage?: Usage;
  // Provider-opaque content replayed unchanged to the provider that produced it (Anthropic's signed
  // thinking blocks). Never shown, never edited; dropped when the history is rewritten.
  replay?: unknown;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  // A tool call is streaming: its name, then again each time one of its string args completes
  // (for display only: the call itself is the later tool_call).
  | { type: "tool_pending"; name: string; args?: Record<string, string> }
  | { type: "tool_call"; call: ToolCall } // emitted ONLY when its JSON args are complete
  | { type: "replay"; data: unknown } // the finished message as the provider wants it back
  | { type: "progress"; done: number; total: number } // prompt tokens read so far (llama.cpp's return_progress)
  | { type: "done"; stop: StopReason; usage?: Usage }
  | { type: "error"; message: string };

export interface ToolSpec {
  name: string;
  description: string;
  schema: object;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal: AbortSignal;
  effort?: "off" | "low" | "medium" | "high"; // overrides the provider's configured reasoning effort
  budget?: number; // overrides the configured thinking budget (tokens; 0 = no cap)
}

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
  /** The models this endpoint serves, for a picker. Optional: not every engine can say. */
  models?(signal: AbortSignal): Promise<string[]>;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  onOutput?: (chunk: string) => void;
}

export interface Tool extends ToolSpec {
  readOnly?: boolean;
  // oxlint-disable-next-line typescript/no-explicit-any -- Tool.run args are validated by schema, so the wire type stays open.
  run(args: any, ctx: ToolContext): Promise<string>;
}