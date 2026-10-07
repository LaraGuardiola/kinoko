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

export interface Message {
  id: string;
  parentId?: string;
  role: Role;
  content: string;
  thinking?: string; // display + session logs ONLY: never sent back to a provider
  toolCalls?: ToolCall[];
  toolCallId?: string; // toolCallId only on role "tool"
  stop?: StopReason;
  usage?: Usage;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; call: ToolCall } // emitted ONLY when its JSON args are complete
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
}

export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
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