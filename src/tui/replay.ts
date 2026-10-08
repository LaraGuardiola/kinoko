// A resumed session's conversation, as the blocks the live view would have printed: what you
// said, what the model answered, and each tool call with its result. Thinking is left out (it is
// not part of the conversation the model sees either).

import { isSummary } from "../compact.ts";
import type { Message } from "../types.ts";
import { toolBlock, toolSummary } from "./tools.ts";
import { ABORTED, formatBlock } from "./view.ts";
import type { BlockKind } from "./view.ts";

/** The loop's own notes to the model (nudges): not something the user said. */
const NOTE = "[kinoko]";

/** `cols` is the terminal width: text wraps two columns short of it, tool bands span it (as live). */
export function replayBlocks(messages: Message[], cols = 80): Array<{ kind: BlockKind; text: string }> {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m.content);
  const out: Array<{ kind: BlockKind; text: string }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (isSummary(m)) out.push({ kind: "system", text: "(the conversation before this point was compacted into a summary)" });
      else if (!m.content.startsWith(NOTE)) out.push({ kind: "user", text: formatBlock("user", m.content) });
    } else if (m.role === "assistant") {
      const text = m.content.trim() === "" ? "" : formatBlock("assistant", m.content, cols - 2);
      if (text !== "") out.push({ kind: "assistant", text });
      for (const call of m.toolCalls ?? []) {
        const output = results.get(call.id) ?? "";
        const view = { name: call.name, args: toolSummary(call.name, call.args), output, aborted: output === ABORTED };
        out.push({ kind: "tool", text: toolBlock(view, false, cols) });
      }
    }
  }
  return out;
}
