import { describe, expect, test } from "bun:test";
import { latestTodos, todosOf } from "../../src/tui/todos.ts";
import type { Tool } from "../../src/types.ts";
import install, { parseItems, summary } from "./todo.ts";

const call = (id: string, items: unknown) => ({ id, name: "todo", args: { items } });

describe("todo extension", () => {
  test("registers one read-only tool that answers with the plan as it now stands", async () => {
    const tools: Tool[] = [];
    install({ registerTool: (t: Tool) => tools.push(t) } as never);
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([["todo", true]]);
    const out = await tools[0]!.run(
      { items: [{ text: "read the loop", status: "done" }, { text: "write the parser", status: "in_progress" }, { text: "tests", status: "pending" }] },
      { signal: new AbortController().signal, cwd: "/" },
    );
    expect(out).toBe("Plan: 1/3 done\n[x] read the loop\n[>] write the parser\n[ ] tests\nKeep it current: send the whole list again when an item starts or finishes.");
    expect(summary([{ text: "a", status: "done" }])).toEndWith("All done.");
  });

  test("a list that is not one is refused with what to fix", () => {
    expect(() => parseItems({})).toThrow("items must be a non-empty list");
    expect(() => parseItems({ items: [{ text: "", status: "done" }] })).toThrow("item 1 needs a text");
    expect(() => parseItems({ items: [{ text: "x", status: "doing" }] })).toThrow("item 1: status must be");
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
    expect(plan).toEqual([{ text: "old", status: "pending" }]); // the refused call does not count
  });
});
