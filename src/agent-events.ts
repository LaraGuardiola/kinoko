// What an Agent tells its listeners, in the order a run produces them: the TUI draws these, the rpc
// mode writes them as JSON lines, and `kinoko serve` relays them to the phone (docs/protocol.md).

import type { ApprovalBy } from "./approvals.ts";
import type { Message, ToolCall } from "./types.ts";

export type AgentEvent =
  | { type: "run_start"; prompt: string }
  | { type: "request_start"; at: number } // epoch ms: TUI shows "reading prompt..." until first_token
  | { type: "first_token"; at: number } // epoch ms of the first delta of any kind
  | { type: "message_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_pending"; name: string; args?: Record<string, string>; index?: number } // a call being written, args so far
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  | { type: "queue_change"; steer: string[]; followUp: string[] }
  | { type: "delivered"; text: string } // a queued steer/follow-up just reached the model
  | { type: "compacting"; phase: "reading" | "writing"; done: number; total?: number } // a summary on its way
  | { type: "compacted"; keep: number } // head of the history replaced by a summary, tail kept
  | { type: "approval_request"; id: string; call: ToolCall; reason: string } // an extension asks the user first
  | { type: "approval_end"; id: string; allow: boolean; by: ApprovalBy } // answered (the first answer wins)
  | { type: "jobs"; running: number } // background jobs running now (bash background: true), when the count changes
  | { type: "model"; model: string } // the model was switched (from the next request on)
  | { type: "retry"; attempt: number; of: number; inMs: number; error: string } // a transient failure: the same request again
  | { type: "run_end"; reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };

// `detail` says which limit or error stopped the run, for the UI.
export type RunResult = { reason: "done" | "aborted" | "error" | "limit"; dropped?: string[]; detail?: string };
