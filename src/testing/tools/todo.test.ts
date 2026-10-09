import { describe, expect, test } from "bun:test";
import { defaultTools } from "../../tools/registry.ts";
import { parseTodos, planText, todoTool } from "../../tools/todo.ts";
import { latestTodos, todosOf } from "../../tui/todos.ts";

const call = (id: string, items: unknown) => ({ id, name: "todo", args: { items } });
const ctx = { signal: new AbortController().signal, cwd: "/" };

describe("todo tool", () => {
  test("a core tool, read-only, answering with the plan as it now stands", async () => {
    expect(defaultTools().map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "search", "todo"]);
    expect(todoTool.readOnly).toBe(true);
    const out = await todoTool.run(
      { items: [{ text: "read the loop", status: "done" }, { text: "write the parser", status: "in_progress" }, { text: "tests", status: "pending" }] },
      ctx,
    );
    expect(out).toBe(
      "Plan: 1/3 done\n[x] read the loop\n[>] write the parser\n[ ] tests\nKeep it current: send the whole list again when an item starts or finishes, adding any new work to it.",
    );
    // All done is not the end of the plan: new work goes into the same list.
    expect(planText([{ text: "a", status: "done" }])).toContain("All done. If more work comes up");
    expect(todoTool.description).toContain("add it to the same list, keeping the done items, even after everything was done");
  });

  test("a list that is not one is refused with what to fix", () => {
    expect(() => parseTodos({})).toThrow("items must be a non-empty list");
    expect(() => parseTodos({ items: [{ text: "", status: "done" }] })).toThrow("item 1 needs a text");
    expect(() => parseTodos({ items: [{ text: "x", status: "doing" }] })).toThrow("item 1: status must be");
  });

  test("the side panel reads the same args: the newest successful call is the plan", () => {
    expect(todosOf({ items: [{ text: "x", status: "in_progress" }] })).toEqual([{ text: "x", status: "in_progress" }]);
    expect(todosOf({ items: [{ text: "x", status: "doing" }] })).toBeUndefined(); // refused by the tool: never shown
    const plan = latestTodos([
      { id: "1", role: "assistant", content: "", toolCalls: [call("a", [{ text: "old", status: "pending" }])] },
      { id: "2", role: "tool", content: "Plan: 0/1 done", toolCallId: "a" },
      { id: "3", role: "assistant", content: "", toolCalls: [call("b", [{ text: "bad", status: "nope" }])] },
      { id: "4", role: "tool", content: "ERROR: item 1: status must be pending, in_progress or done", toolCallId: "b" },
    ]);
    expect(plan).toEqual([{ text: "old", status: "pending" }]);
  });
});
