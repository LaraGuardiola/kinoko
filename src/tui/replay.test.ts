import { describe, expect, test } from "bun:test";
import type { Message } from "../types.ts";
import { replayBlocks } from "./replay.ts";

const strip = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("replaying a resumed session", () => {
  const history: Message[] = [
    { id: "s", role: "user", content: "<compacted_summary>\nObjective: x\n</compacted_summary>" },
    { id: "u", role: "user", content: "make the game" },
    { id: "a", role: "assistant", content: "On it.", thinking: "private", toolCalls: [{ id: "c", name: "write", args: { path: "a.ts", content: "x" } }] },
    { id: "t", role: "tool", toolCallId: "c", content: "wrote 1 lines (1 chars) to a.ts" },
    { id: "n", role: "user", content: "[kinoko] Your last reply hit the output token limit" },
    { id: "a2", role: "assistant", content: "Done." },
  ];

  test("user, answer, and each tool call with its result, in order; no thinking, no nudges", () => {
    const blocks = replayBlocks(history, 60);
    expect(blocks.map((b) => b.kind)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(strip(blocks[1]!.text)).toBe("make the game");
    expect(strip(blocks[3]!.text)).toContain("write a.ts");
    expect(strip(blocks[3]!.text)).toContain("wrote 1 lines");
    const all = blocks.map((b) => strip(b.text)).join("\n");
    expect(all).not.toContain("private");
    expect(all).not.toContain("[kinoko]");
  });
});
