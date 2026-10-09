import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { gitChanges, parseNumstat } from "../../tui/changes.ts";
import type { Git } from "../../tui/changes.ts";

const ROOT = `${process.cwd()}/.tmp-changes-test-${process.pid}`;
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const signal = new AbortController().signal;

/** A fake git: answers by its subcommand, undefined (failure) for anything else. */
function fakeGit(answers: Record<string, string | undefined>): { git: Git; asked: string[][] } {
  const asked: string[][] = [];
  const git: Git = async (args) => {
    asked.push(args);
    return answers[args.join(" ")];
  };
  return { git, asked };
}

describe("working tree changes", () => {
  test("numstat lines: counts, binaries as '-', paths with spaces", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n1\t0\tmy file.md\n\n")).toEqual([
      { path: "src/a.ts", added: 12, removed: 3 },
      { path: "img.png", added: 0, removed: 0, binary: true },
      { path: "my file.md", added: 1, removed: 0 },
    ]);
  });

  test("against HEAD, plus new files counted by their lines; sorted by path", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/new.ts`, "a\nb\nc\n");
    writeFileSync(`${ROOT}/blob.bin`, new Uint8Array([1, 0, 2]));
    const { git, asked } = fakeGit({
      "rev-parse --show-toplevel": `${ROOT}\n`,
      "diff HEAD --numstat --no-renames": "5\t1\tsrc/z.ts\n",
      "ls-files --others --exclude-standard": "new.ts\nblob.bin\n",
    });
    expect(await gitChanges(`${ROOT}/sub`, signal, git)).toEqual([
      { path: "blob.bin", added: 0, removed: 0, binary: true, fresh: true },
      { path: "new.ts", added: 3, removed: 0, fresh: true },
      { path: "src/z.ts", added: 5, removed: 1 },
    ]);
    expect(asked[0]).toEqual(["rev-parse", "--show-toplevel"]);
  });

  test("no commit yet: staged and unstaged summed; outside a repository: undefined", async () => {
    const { git } = fakeGit({
      "rev-parse --show-toplevel": `${ROOT}\n`,
      "diff --cached --numstat --no-renames": "4\t0\ta.ts\n",
      "diff --numstat --no-renames": "2\t1\ta.ts\n",
      "ls-files --others --exclude-standard": "",
    });
    expect(await gitChanges(ROOT, signal, git)).toEqual([{ path: "a.ts", added: 6, removed: 1 }]);
    expect(await gitChanges(ROOT, signal, fakeGit({}).git)).toBeUndefined();
  });
});
