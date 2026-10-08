// Loop guards: cheap, incremental checks that tell when the model is stuck, so the loop can nudge
// it (or stop) instead of letting it burn hours. Pure bookkeeping, no I/O.

import type { ToolCall } from "./types.ts";

/** A streamed line this many times in one reply means the model is going round in circles. */
export const REPEAT_LINES = 8;
/** Shorter lines ("```", "}", "Let me think.") repeat legitimately across a reply... */
const MIN_LINE = 24;
/** ...but not this many times in a row: `"strict": true,` x129 is a degenerate loop. */
export const REPEAT_RUN = 12;
/** The same call with the same result this many times in a row: warn the model. */
export const WARN_CALLS = 3;
/** ...and this many: the run is stuck, stop it. */
export const STOP_CALLS = 10;
/** Nudges in a row (cut-off or looping replies) before the run gives up. */
export const MAX_NUDGES = 3;

export const NUDGE_LENGTH =
  "[kinoko] Your last reply hit the output token limit before you acted, so it was cut off. Do not restart your " +
  "reasoning: continue from where it stopped and make the next tool call now. Do not draft whole files in your " +
  "thinking; write large files in several smaller steps.";
export const NUDGE_EMPTY =
  "[kinoko] Your last reply had no answer and no tool call (a tool call written inside your thinking does not " +
  "run). Close your thinking, then either make the tool call or say that the task is done.";
export const NUDGE_REPEAT =
  "[kinoko] Your last reply was cut because you kept repeating the same lines. Stop deliberating: pick one " +
  "approach and make the next tool call now.";

/** Counts complete lines of one streamed reply; trips on REPEAT_LINES copies or a REPEAT_RUN streak. */
export class RepeatGuard {
  #partial = "";
  #counts = new Map<string, number>();
  #last = "";
  #run = 0;

  /** Feeds a delta; returns true when the reply is looping. */
  push(delta: string): boolean {
    const lines = (this.#partial + delta).split("\n");
    this.#partial = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "") continue;
      this.#run = line === this.#last ? this.#run + 1 : 1;
      this.#last = line;
      if (this.#run >= REPEAT_RUN) return true;
      if (line.length < MIN_LINE) continue;
      const n = (this.#counts.get(line) ?? 0) + 1;
      this.#counts.set(line, n);
      if (n >= REPEAT_LINES) return true;
    }
    return false;
  }
}

/** Tracks identical tool calls that keep returning identical results within one run. */
export class CallGuard {
  #last = new Map<string, { output: string; count: number }>();

  /** Records a finished call; returns how many times in a row it produced this same output. */
  record(call: ToolCall, output: string): number {
    const key = `${call.name}\u0000${JSON.stringify(call.args ?? {})}`;
    const prev = this.#last.get(key);
    const count = prev && prev.output === output ? prev.count + 1 : 1;
    this.#last.set(key, { output, count });
    return count;
  }
}

/** The note appended to a tool result that has come back unchanged `count` times. */
export function repeatNote(count: number): string {
  return (
    `\n\n[kinoko] You have made this exact call ${count} times and got this exact result every time. ` +
    "Repeating it will not change anything: try a different approach."
  );
}
