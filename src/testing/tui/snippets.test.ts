import { describe, expect, test } from "bun:test";
import { copyPage } from "../../tui/menu-pages.ts";
import { snippets } from "../../tui/snippets.ts";
import type { Message } from "../../types.ts";

const reply = (content: string): Message => ({ id: content.slice(0, 8), role: "assistant", content });

describe("snippets", () => {
  test("the replies' code blocks, newest first, with their language; user messages and empty blocks left out", () => {
    const messages: Message[] = [
      reply("Here:\n```ts\nconst a = 1;\nconst b = 2;\n```\nand\n~~~\nls -la\n~~~"),
      { id: "u", role: "user", content: "```py\nprint(1)\n```" },
      reply("```diff\n-a\n+b\n```\n```\n\n```"),
    ];
    expect(snippets(messages)).toEqual([
      { lang: "diff", code: "-a\n+b" },
      { lang: "", code: "ls -la" },
      { lang: "ts", code: "const a = 1;\nconst b = 2;" },
    ]);
  });

  test("a block still open (the reply cut short) is offered up to the end", () => {
    expect(snippets([reply("```sh\necho hi")])).toEqual([{ lang: "sh", code: "echo hi" }]);
  });

  test("the copy page names each by language and first line; picking one copies its code", () => {
    const copied: string[] = [];
    const page = copyPage(snippets([reply("```ts\n\nexport const x = 1;\n```")]), (s) => copied.push(s.code));
    expect(page.items[0]).toMatchObject({ name: "TypeScript", description: "export const x = 1;  · 2 lines" });
    page.pick(page.items[0]!);
    expect(copied).toEqual(["\nexport const x = 1;"]);
    expect(copyPage([], () => {}).empty).toContain("no code blocks");
  });
});
