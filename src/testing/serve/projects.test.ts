import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "../../serve/projects.ts";

const root = mkdtempSync(join(tmpdir(), "kinoko-projects-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sessions = join(root, "sessions");
const work = join(root, "home", "work");
const scratch = join(root, "scratch", "run-1");
mkdirSync(work, { recursive: true });
mkdirSync(scratch, { recursive: true });

function session(folder: string, cwd: string, said: string): void {
  mkdirSync(join(sessions, folder), { recursive: true });
  const lines = [{ type: "session", meta: { id: `${folder}-1`, cwd } }, { type: "message", message: { role: "user", content: said } }];
  writeFileSync(join(sessions, folder, `${folder}-1.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

session("a", work, "fix the build");
session("b", scratch, "a test run");
session("c", join(root, "home", "deleted"), "since removed");

describe("where an agent can start", () => {
  test("the projects worked in, not the throwaway ones nor the deleted", async () => {
    const found = await projects(sessions, 20, 8, [join(root, "scratch")]);
    expect(found.map((p) => p.cwd)).toEqual([work]);
    expect(found[0]?.sessions.map((s) => s.title)).toEqual(["fix the build"]);
  });
});
