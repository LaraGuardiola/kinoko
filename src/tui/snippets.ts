// The code blocks and formulas of a conversation's replies, newest first: what /copy offers to copy.

import type { Message } from "../types.ts";
import { fenceOpener, isClosing, mathBlock } from "./markdown.ts";

export interface Snippet {
  lang: string;
  code: string;
}

export function snippets(messages: Message[]): Snippet[] {
  const out: Snippet[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const lines = message.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const marker = fenceOpener(lines[i] ?? "");
      // A $$ or \[ formula too: its TeX.
      const math = marker === undefined ? mathBlock(lines, i) : undefined;
      if (math !== undefined) {
        out.push({ lang: "math", code: math.source });
        i = math.end;
        continue;
      }
      if (marker === undefined) continue;
      const lang = (lines[i] ?? "").trim().slice(marker.length).trim().split(/\s/)[0] ?? "";
      let end = i + 1;
      while (end < lines.length && !isClosing(lines[end] ?? "", marker)) end++;
      const code = lines.slice(i + 1, end).join("\n");
      if (code.trim() !== "") out.push({ lang, code });
      i = end;
    }
  }
  return out.toReversed();
}
