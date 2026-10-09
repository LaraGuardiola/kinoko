import { describe, expect, test } from "bun:test";
import { osc52, snippets } from "../../tui/copy.ts";
import { fencedBlocks } from "../../tui/markdown.ts";

describe("copying code blocks", () => {
  test("blocks come out as written: no fences, every line, in order; only the model's", () => {
    const text = "Run this:\n```bash\nbun test\n```\nthen\n~~~\nplain\n  indented\n~~~\n";
    expect(fencedBlocks(text)).toEqual([
      { lang: "bash", code: "bun test" },
      { lang: "", code: "plain\n  indented" },
    ]);
    const all = snippets([
      { id: "1", role: "user", content: "```ts\nmine\n```" },
      { id: "2", role: "assistant", content: text },
      { id: "3", role: "assistant", content: "```jsonl\n{\"a\":1}\n```" },
    ]);
    expect(all.map((s) => s.code)).toEqual(["bun test", "plain\n  indented", '{"a":1}']);
  });

  test("OSC 52 carries the text as base64, UTF-8 included", () => {
    expect(osc52("héllo")).toBe(`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
  });
});
