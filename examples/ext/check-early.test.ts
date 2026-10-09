import { describe, expect, test } from "bun:test";
import { Extensions } from "../../src/ext.ts";
import install, { EVERY, NOTE } from "./check-early.ts";

const signal = new AbortController().signal;

function setup(): (name: string, args: Record<string, unknown>, output: string) => string {
  const ext = new Extensions(() => {});
  install(ext);
  return (name, args, output) => {
    ext.beforeTool({ name, args, signal });
    const result = { name, output, signal };
    ext.emit("tool_result", result);
    return result.output;
  };
}

const write = (path: string): [string, Record<string, unknown>, string] => ["write", { path, content: "x" }, `wrote 1 lines to ${path}`];

describe("check-early extension", () => {
  test(`the ${EVERY}th source file written without a check gets the note, once`, () => {
    const run = setup();
    for (let i = 1; i < EVERY; i++) expect(run(...write(`src/f${i}.ts`))).toBe(`wrote 1 lines to src/f${i}.ts`);
    expect(run(...write("src/last.ts"))).toBe(`wrote 1 lines to src/last.ts${NOTE(EVERY)}`);
    expect(run(...write("src/next.ts"))).toBe("wrote 1 lines to src/next.ts"); // the count starts again
  });

  test("a check command starts the count again", () => {
    const run = setup();
    for (let i = 1; i < EVERY; i++) run(...write(`src/f${i}.ts`));
    run("bash", { command: "bun run typecheck 2>&1" }, "ok");
    expect(run(...write("src/after.ts"))).not.toContain("[check-early]");
  });

  test("other commands, docs, failed writes and the same file again do not count", () => {
    const run = setup();
    for (let i = 1; i < EVERY; i++) run(...write(`src/f${i}.ts`));
    run("bash", { command: "git status" }, "clean");
    expect(run(...write("README.md"))).not.toContain("[check-early]");
    expect(run("write", { path: "src/bad.ts" }, "ERROR: write: missing content (string)")).not.toContain("[check-early]");
    expect(run("edit", { path: "src/f1.ts", edits: [] }, "edited src/f1.ts")).not.toContain("[check-early]");
    expect(run("edit", { path: "src/new.ts", edits: [] }, "edited src/new.ts")).toContain("[check-early]");
  });
});
