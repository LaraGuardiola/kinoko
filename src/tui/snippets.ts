// The code blocks of a conversation's replies, newest first: what /copy offers to copy.

import type { Message } from "../types.ts";
import { fenceOpener, isClosing } from "./markdown.ts";

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
