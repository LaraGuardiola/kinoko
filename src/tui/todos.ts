// The model's plan, as the side panel shows it. The plan is whatever the last call to the `todo`
// tool said (the todo extension, examples/ext/todo.ts): the whole list every time, so the newest
// call is the truth and a resumed session finds it again in its history.

import type { Message, ToolCall } from "../types.ts";

export const TODO_TOOL = "todo";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface Todo {
  text: string;
  status: TodoStatus;
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "done"]);

/** A todo call's list, or undefined when its args are not one (the tool refused it too). */
export function todosOf(args: unknown): Todo[] | undefined {
  const items = (args as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const out: Todo[] = [];
  for (const item of items) {
    const { text, status } = (item ?? {}) as { text?: unknown; status?: unknown };
    // As strict as the tool: a list it refuses never shows, not even while the call runs.
    if (typeof text !== "string" || text.trim() === "" || typeof status !== "string" || !STATUSES.has(status)) return undefined;
    out.push({ text: text.trim(), status: status as TodoStatus });
  }
  return out;
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
