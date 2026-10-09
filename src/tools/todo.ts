// todo: the model's plan for work with several steps, which the TUI shows in its side panel. The
// WHOLE list every call: a small model never has to track ids or patch a list it cannot see, and
// the newest call is the truth (a resumed session finds it again in its history).

import type { Tool } from "../types";

export const TODO_TOOL = "todo";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface Todo {
  text: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];
const MARKS: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]" };

/** The list as sent, checked; throws (the tool error the model reads) when it is not one. */
export function parseTodos(args: unknown): Todo[] {
  const items = (args as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty list of { text, status }");
  return items.map((item, i) => {
    const { text, status } = (item ?? {}) as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || text.trim() === "") throw new Error(`item ${i + 1} needs a text`);
    if (!STATUSES.includes(status as TodoStatus)) throw new Error(`item ${i + 1}: status must be pending, in_progress or done`);
    return { text: text.trim(), status: status as TodoStatus };
  });
}

/** What the model reads back: the plan as it now stands, and what to do next. */
export function planText(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "done").length;
  const list = todos.map((t) => `${MARKS[t.status]} ${t.text}`).join("\n");
  // "All done." alone read as "the plan is over": new work then went on with no plan at all.
  const next =
    done === todos.length
      ? "All done. If more work comes up (a fix, a check, a follow-up), add it to this same list (keep the done items) and send it again."
      : "Keep it current: send the whole list again when an item starts or finishes, adding any new work to it.";
  return `Plan: ${done}/${todos.length} done\n${list}\n${next}`;
}

export const todoTool: Tool = {
  name: TODO_TOOL,
  description:
    "Keep a short plan for a task with several steps. Send the WHOLE list every time. Mark the step you start as in_progress (one at a time) and each finished step as done. When new work comes up (a fix, a check, a follow-up), add it to the same list, keeping the done items, even after everything was done. Skip it for one-step tasks.",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "the step, a few words" },
            status: { type: "string", enum: [...STATUSES] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["items"],
  },
  readOnly: true,
  run: async (args: unknown) => planText(parseTodos(args)),
};
