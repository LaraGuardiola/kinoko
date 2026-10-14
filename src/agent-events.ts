// What an Agent tells its listeners, in the order a run produces them: the TUI draws these, the rpc
// mode writes them as JSON lines, and `kinoko serve` relays them to the phone and to Kinoko Lab
// (docs/protocol.md). Some are only for the Lab (prefill, gate, appended, guard): they show what
// the harness does between the lines a chat shows, and a client that does not draw them ignores them.

import type { ApprovalBy } from "./approvals.ts";
import type { Message, ToolCall } from "./types.ts";

/** What a request carries (inspect.ts measures it). */
export interface RequestSize {
  messages: number;
  tools: number;
  /** Everything the model reads: the system prompt, the tool schemas, the history. */
  chars: number;
  /** An estimate: the server's own count of the last reply when there is one, chars/4 otherwise. */
  tokens: number;
}

/** Why a message joined the history: the user's, the model's, a tool's, or the harness's own. */
export type AppendKind = "prompt" | "steer" | "follow_up" | "reply" | "result" | "note" | "nudge";

/** What a guard noticed: a reply looping, empty or cut off; a call repeated, failing, or unknown. */
export type GuardKind = "repeat" | "empty" | "length" | "same_call" | "same_error" | "unknown_tool";

export type AgentEvent =
  | { type: "run_start"; prompt: string }
  | ({ type: "request_start"; at: number; model: string } & RequestSize) // epoch ms: TUI shows "reading prompt..." until first_token
  | { type: "prefill"; done: number; total: number } // prompt tokens the engine has read (llama.cpp), a few times a second
  | { type: "first_token"; at: number } // epoch ms of the first delta of any kind
  | { type: "message_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_pending"; name: string; args?: Record<string, string>; index?: number } // a call being written, args so far
  | { type: "tool_start"; call: ToolCall }
  // The extensions' word on a call: it runs (pass), it does not (block), or the user is asked (ask;
  // `skipped` when nobody is: a profile that allows all, or a call allowed for the session).
  // `by` names the extension that decided; `rewritten` when one changed the call's arguments.
  | { type: "gate"; call: ToolCall; decision: "pass" | "block" | "ask"; by?: string; reason?: string; rewritten?: boolean; skipped?: "auto" | "remembered" }
  | { type: "tool_output"; call: ToolCall; output: string }
  | { type: "tool_end"; call: ToolCall }
  // A message joined the history (the next request carries it). `text` only for what the harness
  // wrote itself (a note, a nudge): the rest a client already has.
  | { type: "appended"; role: Message["role"]; kind: AppendKind; chars: number; text?: string }
  | { type: "guard"; what: GuardKind; detail: string }
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
