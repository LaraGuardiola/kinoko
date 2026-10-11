// The approval prompt: a tool call an extension asks about, shown above the editor until someone
// answers (here with y, n, a or Esc; or the phone, or Telegram). Keys go to it first while it shows.

import type { ApprovalBy } from "../approvals.ts";
import type { Key } from "./term.ts";
import type { ToolCall } from "../types.ts";
import { ANSI } from "./style.ts";

export interface ApprovalView {
  id: string;
  call: ToolCall;
  reason: string;
}

/** What a key does to the prompt: an answer, or nothing (the key is swallowed while it shows). */
export function approvalKey(key: Key): { allow: boolean; remember?: boolean } | undefined {
  if (key.name === "escape") return { allow: false };
  if (key.name !== "char") return undefined;
  const char = (key.char ?? "").toLowerCase();
  if (char === "y") return { allow: true };
  if (char === "n") return { allow: false };
  if (char === "a") return { allow: true, remember: true };
  return undefined;
}

/** The rows: why it asks, the command in cream (at most 6 lines), the keys. */
export function approvalRows(view: ApprovalView): string[] {
  const lines = commandOf(view.call).split("\n");
  const shown = lines.length > 6 ? [...lines.slice(0, 5), `… ${lines.length - 5} more lines`] : lines;
  return [
    "",
    `${ANSI.dim}🔐 ${view.reason}${ANSI.reset}`,
    ...shown.map((line) => `${ANSI.cream}${line}${ANSI.reset}`),
    `${ANSI.dim}y allow · n deny · a allow for this session · esc deny${ANSI.reset}`,
  ];
}

/** The call as the user reads it: a shell command as it is, any other tool by name and args. */
export function commandOf(call: ToolCall): string {
  const args = call.args as Record<string, unknown>;
  const command = args.command ?? args.cmd;
  return call.name === "bash" && typeof command === "string" ? `$ ${command}` : `${call.name} ${JSON.stringify(args)}`;
}

/** The note after someone else answered (or nobody did); empty when this terminal answered. */
export function answeredNote(allow: boolean, by: ApprovalBy): string {
  if (by === "tui" || by === "abort") return "";
  if (by === "timeout") return "nobody answered: denied";
  return `${allow ? "allowed" : "denied"} from ${by === "app" ? "the phone" : "Telegram"}`;
}
