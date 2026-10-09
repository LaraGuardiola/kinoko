// The model's plan, as the side panel shows it: whatever the last successful call to the core
// `todo` tool (src/tools/todo.ts) said.

import type { Message, ToolCall } from "../types.ts";
import { TODO_TOOL, parseTodos } from "../tools/todo.ts";
import type { Todo } from "../tools/todo.ts";

export { TODO_TOOL };
export type { Todo, TodoStatus } from "../tools/todo.ts";

/** A todo call's list, or undefined when the tool refuses it: such a list never shows. */
export function todosOf(args: unknown): Todo[] | undefined {
  try {
    return parseTodos(args);
  } catch {
    return undefined;
  }
}

/** The plan as of the newest todo call that succeeded; [] when there was none. */
export function latestTodos(messages: Message[]): Todo[] {
  const failed = new Set(messages.filter((m) => m.role === "tool" && m.content.startsWith("ERROR")).map((m) => m.toolCallId));
  const calls: ToolCall[] = messages.flatMap((m) => m.toolCalls ?? []);
  for (const call of calls.toReversed()) {
    if (call.name !== TODO_TOOL || failed.has(call.id)) continue;
    const todos = todosOf(call.args);
    if (todos !== undefined) return todos;
  }
  return [];
}
