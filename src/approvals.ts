// Approvals: a tool call an extension asks about waits here for the user's answer, from whoever
// answers first (the TUI, the phone, Telegram). The wait honors the run's AbortSignal (Esc denies)
// and a timeout (no answer denies). "Allow for this session" is remembered in memory only.

import type { ToolCall } from "./types.ts";

/** Who settled a request: a client, or the wait itself. */
export type ApprovalBy = "tui" | "app" | "telegram" | "timeout" | "abort";

export interface ApprovalAnswer {
  allow: boolean;
  by: ApprovalBy;
  remember?: boolean;
}

export class Approvals {
  #pending = new Map<string, (answer: ApprovalAnswer) => void>();
  #allowed = new Set<string>();
  #timeoutMs: number;

  /** `timeoutMs` 0: nobody can answer here (print mode), so every ask is a deny at once. */
  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  /** Allowed for this session already: no need to ask. */
  remembered(call: ToolCall): boolean {
    return this.#allowed.has(keyOf(call));
  }

  /** Waits for `answer(id, ...)`, the abort of `signal`, or the timeout, whichever comes first. */
  wait(id: string, call: ToolCall, signal: AbortSignal): Promise<ApprovalAnswer> {
    return new Promise((done) => {
      if (signal.aborted) return done({ allow: false, by: "abort" });
      if (this.#timeoutMs <= 0) return done({ allow: false, by: "timeout" });
      const finish = (answer: ApprovalAnswer): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        if (answer.allow && answer.remember) this.#allowed.add(keyOf(call));
        done(answer);
      };
      const onAbort = (): void => finish({ allow: false, by: "abort" });
      const timer = setTimeout(() => finish({ allow: false, by: "timeout" }), this.#timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, finish);
    });
  }

  /** Settles a waiting request; false when it is not waiting (already answered, or unknown). */
  answer(id: string, answer: ApprovalAnswer): boolean {
    const finish = this.#pending.get(id);
    if (finish === undefined) return false;
    finish(answer);
    return true;
  }

  /** A new session: what was allowed for the last one is not any more. */
  forget(): void {
    this.#allowed.clear();
  }
}

/** The tool and its command (bash), whitespace collapsed, or its args: what "this session" allows. */
function keyOf(call: ToolCall): string {
  const args = call.args as Record<string, unknown>;
  const command = args.command ?? args.cmd;
  const what = typeof command === "string" ? command.trim().replace(/\s+/g, " ") : JSON.stringify(args);
  return `${call.name}\u0000${what}`;
}
