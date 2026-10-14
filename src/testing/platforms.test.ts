import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSIONS, SKILLS, catalog, spawnRun } from "../catalog.ts";
import { discoverSkills } from "../context.ts";
import { Extensions } from "../ext.ts";
import { loadExtensions } from "../ext-load.ts";
import { platformsLabel, platformsOf, runsHere } from "../platforms.ts";

const root = mkdtempSync(join(tmpdir(), "kinoko-platforms-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const signal = new AbortController().signal;
/** A system that is not this one, whatever this one is: these tests pass everywhere. */
const ELSEWHERE = process.platform === "win32" ? "linux" : "win32";
const HERE = process.platform;

function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("where an extension or a skill works", () => {
  test("the systems named, by any common name; none named is everywhere", () => {
    expect(platformsOf(["linux", "macos"])).toEqual(["linux", "darwin"]);
    expect(platformsOf("linux, Windows")).toEqual(["linux", "win32"]);
    expect(platformsOf("[mac, osx]")).toEqual(["darwin"]);
    expect(platformsOf(undefined)).toBeUndefined();
    expect(platformsOf(["beos"])).toBeUndefined();
    expect(runsHere(undefined, "win32")).toBe(true);
    expect(runsHere(["linux"], "win32")).toBe(false);
    expect(runsHere(["linux", "darwin"], "darwin")).toBe(true);
    expect(platformsLabel(["linux"])).toBe("Linux only");
    expect(platformsLabel(["linux", "darwin"])).toBe("Linux and macOS");
  });

  test("another system's extension is not loaded: none of its tools reach the model", async () => {
    const home = join(root, "ext-home");
    put(join(home, ".kinoko/ext/everywhere/index.ts"), "export default (k) => k.registerTool({ name: 'anywhere', description: '', schema: {}, run: async () => 'x' });\n");
    put(join(home, ".kinoko/ext/elsewhere/index.ts"), "export default (k) => k.registerTool({ name: 'nothere', description: '', schema: {}, run: async () => 'x' });\n");
    put(join(home, ".kinoko/ext/elsewhere/package.json"), JSON.stringify({ os: [ELSEWHERE] }));
    put(join(home, ".kinoko/ext/here/index.ts"), "export default (k) => k.registerTool({ name: 'herealso', description: '', schema: {}, run: async () => 'x' });\n");
    put(join(home, ".kinoko/ext/here/package.json"), JSON.stringify({ os: [HERE, ELSEWHERE] }));
    const said: string[] = [];
    const ext = new Extensions((line) => said.push(line));
    await loadExtensions(ext, { cwd: home, home });
    expect(ext.tools().map((t) => t.name).toSorted()).toEqual(["anywhere", "herealso"]);
    expect(said).toContain("elsewhere is not for this system: not loaded");
  });

  test("another system's skill is not in the index: no prompt spent on it", async () => {
    const home = join(root, "skill-home");
    put(join(home, ".agents/skills/anywhere/SKILL.md"), "---\nname: anywhere\ndescription: everywhere\n---\n");
    put(join(home, ".agents/skills/elsewhere/SKILL.md"), `---\nname: elsewhere\ndescription: not here\nplatforms: ${ELSEWHERE}\n---\n`);
    expect((await discoverSkills(join(home, "proj"), home)).map((s) => s.name)).toEqual(["anywhere"]);
  });

  test("the catalog shows it marked, and will not install it", async () => {
    const repo = join(root, "repo");
    const home = join(root, "cat-home");
    mkdirSync(home, { recursive: true });
    put(join(repo, "local/index.ts"), "export default function (): void {}\n");
    put(join(repo, "local/package.json"), JSON.stringify({ description: "elsewhere only", os: [ELSEWHERE] }));
    put(join(repo, "free/index.ts"), "export default function (): void {}\n");
    put(join(repo, "free/package.json"), JSON.stringify({ description: "anywhere" }));
    await spawnRun(["git", "init", "--quiet", repo], root, signal);
    await spawnRun(["git", "-C", repo, "add", "-A"], repo, signal);
    await spawnRun(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"], repo, signal);
    const store = catalog({ kind: EXTENSIONS, home, repo });
    const entries = await store.list(signal);
    expect(entries.map((e) => [e.name, e.here, e.platforms])).toEqual([
      ["free", undefined, undefined],
      ["local", false, [ELSEWHERE]],
    ]);
    const refused = await store.install("local", signal);
    expect(refused.ok).toBe(false);
    expect(refused.note).toContain("not this system");
    expect(SKILLS.platforms).toBeDefined();
  });
});
