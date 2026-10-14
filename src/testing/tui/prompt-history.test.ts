import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { addToPromptHistory, HISTORY_SIZE, loadPromptHistory } from "../../tui/prompt-history.ts";

const HOME = `${process.cwd()}/.tmp-history-test-${process.pid}`;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("prompt history", () => {
  test("what was sent comes back in order, a message of several lines whole; no file: none", async () => {
    expect(await loadPromptHistory(`${HOME}/nobody`)).toEqual([]);
    await addToPromptHistory(HOME, "first");
    await addToPromptHistory(HOME, "two\nlines");
    expect(await loadPromptHistory(HOME)).toEqual(["first", "two\nlines"]);
    if (process.platform !== "win32") expect(statSync(`${HOME}/.kinoko/history.jsonl`).mode & 0o777).toBe(0o600); // a prompt can hold anything
  });

  test("a line cut short is skipped; a long file keeps the newest and is cut back", async () => {
    const home = `${HOME}/long`;
    await addToPromptHistory(home, "kept");
    await Bun.write(`${home}/.kinoko/history.jsonl`, `${await Bun.file(`${home}/.kinoko/history.jsonl`).text()}"cut sh\n`);
    expect(await loadPromptHistory(home)).toEqual(["kept"]);
    await Bun.write(`${home}/.kinoko/history.jsonl`, Array.from({ length: 1200 }, (_, i) => `${JSON.stringify(`p${i}`)}\n`).join(""));
    const sent = await loadPromptHistory(home);
    expect(sent).toHaveLength(HISTORY_SIZE);
    expect(sent.at(-1)).toBe("p1199");
    expect((await Bun.file(`${home}/.kinoko/history.jsonl`).text()).split("\n").filter(Boolean)).toHaveLength(HISTORY_SIZE);
  });
});
