import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extStore, spawnRun } from "../extstore.ts";
import type { Run } from "../extstore.ts";

// A real git repository on disk stands in for kinoko-extensions; `bun install` is recorded instead
// of run, so no network is needed.
const ROOT = `${process.cwd()}/.tmp-extstore-test-${process.pid}`;
const REPO = join(ROOT, "repo");
const HOME = join(ROOT, "home");
const signal = new AbortController().signal;
const git = (...args: string[]): Promise<{ code: number; out: string }> => spawnRun(["git", "-C", REPO, ...args], REPO, signal);

function put(path: string, text: string): void {
  mkdirSync(join(REPO, path, ".."), { recursive: true });
  writeFileSync(join(REPO, path), text);
}

async function commit(message: string): Promise<void> {
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
}

let installs: string[] = [];
let bunFails = false;
const run: Run = async (cmd, cwd, sig) => {
  if (cmd[0] !== "bun") return spawnRun(cmd, cwd, sig);
  installs.push(cwd);
  return bunFails ? { code: 1, out: "resolving\nerror: puppeteer not found" } : { code: 0, out: "" };
};

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  await spawnRun(["git", "init", "--quiet", REPO], ROOT, signal);
  put("alpha/index.ts", "export default function (): void {}\n");
  put("alpha/index.test.ts", "// not shipped\n");
  put("alpha/package.json", JSON.stringify({ description: "The first one" }));
  put("beta/index.ts", "export default function (): void {}\n");
  put("beta/package.json", JSON.stringify({ description: "Needs a library", dependencies: { puppeteer: "^24.0.0" } }));
  put("testing/bus.ts", "// a helper, not an extension\n");
  put("notes/README.md", "no index.ts: not an extension\n");
  await commit("first");
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("extension store", () => {
  const store = extStore({ home: HOME, repo: REPO, run });
  const ext = join(HOME, ".kinoko", "ext");

  test("lists the repository's folders with an index.ts, with their descriptions", async () => {
    expect(await store.list(signal)).toEqual([
      { name: "alpha", description: "The first one", installed: false },
      { name: "beta", description: "Needs a library", installed: false },
    ]);
    expect(existsSync(join(HOME, ".kinoko", "registry", ".git"))).toBe(true);
  });

  test("installs a folder without its tests; an older single-file copy is replaced (an update)", async () => {
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "alpha.ts"), "// the old copy\n");
    expect(await store.install("alpha", signal)).toBe("alpha updated: restart kinoko to load it");
    expect(existsSync(join(ext, "alpha", "index.ts"))).toBe(true);
    expect(existsSync(join(ext, "alpha", "index.test.ts"))).toBe(false);
    expect(existsSync(join(ext, "alpha.ts"))).toBe(false);
    expect(installs).toEqual([]); // no dependencies, no bun install
    expect((await store.list(signal)).find((e) => e.name === "alpha")?.installed).toBe(true);
  });

  test("dependencies are installed in the extension's own folder; a failure says why", async () => {
    installs = [];
    expect(await store.install("beta", signal)).toBe("beta installed: restart kinoko to load it");
    expect(installs).toEqual([join(ext, "beta")]);
    bunFails = true;
    expect(await store.install("beta", signal)).toBe("beta copied, but its dependencies did not install: error: puppeteer not found");
    bunFails = false;
  });

  test("a listing brings the clone up to date", async () => {
    put("gamma/index.ts", "export default function (): void {}\n");
    await commit("gamma");
    expect((await store.list(signal)).map((e) => e.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("removes an installed one; unknown names and paths are refused", async () => {
    expect(await store.remove("alpha")).toBe("alpha removed: gone when kinoko restarts");
    expect(existsSync(join(ext, "alpha"))).toBe(false);
    expect(await store.remove("alpha")).toBe("alpha is not installed");
    expect(await store.install("nope", signal)).toBe(`no extension called nope in ${REPO}`);
    expect(await store.install("../alpha", signal)).toBe(`no extension called ../alpha in ${REPO}`);
    expect(await store.install("testing", signal)).toBe(`no extension called testing in ${REPO}`);
  });

  test("a repository that cannot be fetched says so", async () => {
    const broken = extStore({ home: join(ROOT, "other"), repo: join(ROOT, "no-such-repo"), run });
    mkdirSync(join(ROOT, "other"), { recursive: true });
    await expect(broken.list(signal)).rejects.toThrow(/^could not fetch .*no-such-repo/);
  });
});
