// Todo: the model keeps a short plan for work with several steps, and kinoko's side panel shows it
// (on a window two thirds of the screen wide or more). One tool, `todo`, that takes the WHOLE list
// every time: a small model never has to track ids or patch a list it cannot see.
// Copy to ~/.kinoko/ext/todo.ts to switch it on; delete the file to switch it off.

import type { Kinoko } from "../../src/ext.ts";

type Status = "pending" | "in_progress" | "done";

interface Item {
  text: string;
  status: Status;
}

const STATUSES = ["pending", "in_progress", "done"] as const;
const MARKS: Record<Status, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]" };

/** The list as sent, checked; throws (the tool error the model reads) when it is not one. */
export function parseItems(args: unknown): Item[] {
  const items = (args as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty list of { text, status }");
  return items.map((item, i) => {
    const { text, status } = (item ?? {}) as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || text.trim() === "") throw new Error(`item ${i + 1} needs a text`);
    if (!STATUSES.includes(status as Status)) throw new Error(`item ${i + 1}: status must be pending, in_progress or done`);
    return { text: text.trim(), status: status as Status };
  });
}

/** What the model reads back: the plan as it now stands, and what to do next. */
export function summary(items: Item[]): string {
  const done = items.filter((i) => i.status === "done").length;
  const list = items.map((i) => `${MARKS[i.status]} ${i.text}`).join("\n");
  const next = done === items.length ? "All done." : "Keep it current: send the whole list again when an item starts or finishes.";
  return `Plan: ${done}/${items.length} done\n${list}\n${next}`;
}

export default function (k: Kinoko): void {
  k.registerTool({
    name: "todo",
    description:
      "Keep a short plan for a task with several steps. Send the WHOLE list every time. Mark the step you start as in_progress (one at a time) and each finished step as done. Skip it for one-step tasks.",
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
    run: async (args: unknown) => summary(parseItems(args)),
  });
}
