import { describe, expect, test } from "bun:test";
import { ArgsWatcher } from "./partial-args.ts";

describe("watching tool args stream in", () => {
  test("a string field is reported the moment its closing quote arrives, one char at a time", () => {
    const watcher = new ArgsWatcher();
    const json = '{"path": "src/a.ts", "content": "say \\"hi\\"\\nbye", "n": 3}';
    const reports: Array<[number, Record<string, string>]> = [];
    for (let i = 0; i < json.length; i++) {
      const done = watcher.push(json[i]!);
      if (done) reports.push([i, done]);
    }
    expect(reports.map(([, fields]) => fields)).toEqual([
      { path: "src/a.ts" },
      { path: "src/a.ts", content: 'say "hi"\nbye' }, // escapes undone; the number is not a string
    ]);
    expect(reports[0]![0]).toBe(json.indexOf('.ts"') + 3); // right at the path's closing quote
  });

  test("an escaped quote inside a value does not end it early", () => {
    const watcher = new ArgsWatcher();
    expect(watcher.push('{"command": "echo \\"')).toBeUndefined();
    expect(watcher.push('x\\" done"}')).toEqual({ command: 'echo "x" done' });
  });
});
