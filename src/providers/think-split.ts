// Fallback for engines that put thinking inside `delta.content` instead of a
// `reasoning_content` / `reasoning` field. Nothing here touches the wire format.

export type ThinkPart = { kind: "text" | "thinking"; delta: string };

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Longest suffix of `s` that is a proper prefix of `tag`, so a tag straddling a boundary is not lost. */
function partialTag(s: string, tag: string): number {
  for (let k = Math.min(s.length, tag.length - 1); k >= 1; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/** Splits `<think>...</think>` out of content deltas; works across chunk boundaries. */
export class ThinkSplit {
  #buf = "";
  #inThink = false;
  #armed = false;

  /** Until a tag is first seen, content passes through as text with no state machine running. */
  push(content: string): ThinkPart[] {
    const joined = this.#buf + content;
    this.#buf = "";
    if (!this.#armed && !joined.includes(THINK_OPEN)) {
      const hold = partialTag(joined, THINK_OPEN);
      this.#buf = hold ? joined.slice(joined.length - hold) : "";
      const head = joined.slice(0, joined.length - hold);
      return head ? [{ kind: "text", delta: head }] : [];
    }
    this.#armed = true;
    return this.#split(joined);
  }

  flush(): ThinkPart[] {
    const rest = this.#buf;
    this.#buf = "";
    if (!rest) return [];
    return [{ kind: this.#inThink ? "thinking" : "text", delta: rest }];
  }

  #split(s: string): ThinkPart[] {
    const out: ThinkPart[] = [];
    let i = 0;
    while (i < s.length) {
      if (this.#inThink) {
        const close = s.indexOf(THINK_CLOSE, i);
        if (close < 0) {
          const end = s.length - partialTag(s.slice(i), THINK_CLOSE);
          if (end > i) out.push({ kind: "thinking", delta: s.slice(i, end) });
          this.#buf = s.slice(end);
          break;
        }
        if (close > i) out.push({ kind: "thinking", delta: s.slice(i, close) });
        i = close + THINK_CLOSE.length;
        this.#inThink = false;
        continue;
      }
      const open = s.indexOf(THINK_OPEN, i);
      if (open < 0) {
        const end = s.length - partialTag(s.slice(i), THINK_OPEN);
        if (end > i) out.push({ kind: "text", delta: s.slice(i, end) });
        this.#buf = s.slice(end);
        break;
      }
      if (open > i) out.push({ kind: "text", delta: s.slice(i, open) });
      i = open + THINK_OPEN.length;
      this.#inThink = true;
    }
    return out;
  }
}