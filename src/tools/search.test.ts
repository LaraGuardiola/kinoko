import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { searchTool } from "./search";
import { estimateTokens } from "./budget";

const ROOT = `${process.cwd()}/.tmp-search-test-${process.pid}`;

function ctx(cwd: string, signal?: AbortSignal): { signal: AbortSignal; cwd: string } {
  return { signal: signal ?? new AbortController().signal, cwd };
}

/** Small repo-ish fixture: .gitignore + a skipped dir + small files. */
function fixture(tag: string, files: number, lines: number): string {
  const dir = `${ROOT}/${tag}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/.gitignore`, "skip/\n");
  mkdirSync(`${dir}/.git`, { recursive: true });
  mkdirSync(`${dir}/skip`, { recursive: true });
  mkdirSync(`${dir}/sub`, { recursive: true });
  writeFileSync(`${dir}/skip/hidden.txt`, "needle hidden\n");
  for (let i = 0; i < files; i = i + 1) {
    const body: string[] = [];
    for (let l = 0; l < lines; l = l + 1) {
      body.push(l % 4 === 0 ? `needle ${l} here` : `filler ${l}`);
    }
    writeFileSync(`${dir}/sub/f${String(i).padStart(3, "0")}.txt`, `${body.join("\n")}\n`);
  }
  return dir;
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Runs the same call on both backends and returns the two answers. */
async function bothBackends(args: Record<string, unknown>, dir: string): Promise<[string, string]> {
  const rg = await searchTool.run(args, ctx(dir));
  process.env.KINOKO_RG_BACKEND = "bun";
  const bun = await searchTool.run(args, ctx(dir));
  process.env.KINOKO_RG_BACKEND = "";
  return [rg, bun];
}

function rgProcs(): number {
  const r = Bun.spawnSync(["sh", "-c", "ps -eo comm= | grep -c '^rg$'"]);
  const text = new TextDecoder().decode(r.stdout).trim();
  return r.exitCode === 0 ? Number.parseInt(text, 10) : 0;
}

describe("search tool", () => {
  test("search: rg and bun backends return identical output", async () => {
    const dir = fixture("repo", 20, 12);
    const rg = await searchTool.run({ pattern: "needle" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "bun";
    const bun = await searchTool.run({ pattern: "needle" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "";
    expect(rg).toBe(bun);
    expect(rg.includes("hidden.txt")).toBe(false);
    const rgFiles = await searchTool.run({ mode: "files", pattern: "*.txt" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "bun";
    const bunFiles = await searchTool.run({ mode: "files", pattern: "*.txt" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "";
    expect(rgFiles).toBe(bunFiles);
    expect(rgFiles.includes("hidden.txt")).toBe(false);
  });

  test("search: budget cap respected, early exit beats full scan", async () => {
    const dir = fixture("big", 400, 4000);
    const t1 = Date.now();
    await searchTool.run({ max_tokens: 100000, pattern: "needle" }, ctx(dir));
    const fullMs = Date.now() - t1;
    const t0 = Date.now();
    const early = await searchTool.run({ max_tokens: 120, pattern: "needle" }, ctx(dir));
    const earlyMs = Date.now() - t0;
    expect(estimateTokens(early) <= 200).toBe(true);
    expect(early.includes("narrow with")).toBe(true);
    expect(earlyMs < fullMs).toBe(true);
  });

  test("search: abort kills the rg process", async () => {
    const dir = fixture("huge", 400, 4000);
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 2);
    const out = await searchTool.run({ max_tokens: 100000, pattern: "needle" }, ctx(dir, c.signal));
    await Bun.sleep(250);
    clearTimeout(timer);
    expect(out.includes("Aborted")).toBe(true);
    expect(rgProcs()).toBe(0);
  });

  // An empty result must be a sentence, never "": a model cannot tell "nothing matched" from
  // "the tool broke", and repeats the call until the turn limit.
  test("search: empty results say so, on both backends, in both modes", async () => {
    const dir = fixture("empty", 2, 4);
    const [noHits, noHitsBun] = await bothBackends({ pattern: "zzz-nothing-matches-this" }, dir);
    expect(noHits).toBe(noHitsBun);
    expect(noHits).toContain("[no matches for `zzz-nothing-matches-this`");
    expect(noHits).not.toBe("");

    const [noFiles, noFilesBun] = await bothBackends({ pattern: "*.nothing", mode: "files" }, dir);
    expect(noFiles).toBe(noFilesBun);
    expect(noFiles).toContain("[no files matching `*.nothing`");

    // A word handed to files mode is the classic model mistake: say what it looked for.
    const [word, wordBun] = await bothBackends({ pattern: "needle", mode: "files" }, dir);
    expect(word).toBe(wordBun);
    expect(word).toContain("in files mode `pattern` is a glob");
    expect(word).toContain('use mode "content"');
  });

  test("search: bad arguments are refused with an error, never a throw", async () => {
    const dir = fixture("bad", 2, 4);
    const [badRegex] = await bothBackends({ pattern: "needle(" }, dir);
    expect(badRegex).toStartWith("ERROR: search: invalid regex pattern");
    const [missing] = await bothBackends({ pattern: "needle", path: "nope" }, dir);
    expect(missing).toBe("ERROR: search: path not found: nope");
    const [missingFiles] = await bothBackends({ pattern: "*.txt", mode: "files", path: "nope" }, dir);
    expect(missingFiles).toBe("ERROR: search: path not found: nope");
    // A file is not something to walk (this used to throw ENOTDIR out of the tool).
    const [notDir, notDirBun] = await bothBackends({ pattern: "needle", path: ".gitignore" }, dir);
    expect(notDir).toBe(notDirBun);
    expect(notDir).toStartWith("ERROR: search: not a directory: .gitignore");
    const [empty] = await bothBackends({ pattern: "" }, dir);
    expect(empty).toBe("ERROR: search: pattern must be a non-empty string");
  });

  test("search: an absolute path works, outside the cwd", async () => {
    const dir = fixture("abs", 3, 6);
    const [rg, bun] = await bothBackends({ pattern: "needle", path: dir }, dir);
    expect(rg).toBe(bun);
    expect(rg).toContain("f000.txt");
    // A path outside the cwd is honoured too (the old code glued it onto the cwd).
    const [parent] = await bothBackends({ pattern: "needle", path: `${dir}/sub` }, dir);
    expect(parent).toContain("f000.txt");
  });

  test("search: .gitignore respected by both backends", async () => {
    const dir = fixture("ign", 4, 4);
    const rg = await searchTool.run({ pattern: "needle" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "bun";
    const bun = await searchTool.run({ pattern: "needle" }, ctx(dir));
    process.env.KINOKO_RG_BACKEND = "";
    expect(rg.includes("hidden.txt")).toBe(false);
    expect(bun.includes("hidden.txt")).toBe(false);
    const forced = await searchTool.run({ no_ignore: true, pattern: "needle" }, ctx(dir));
    expect(forced.includes("hidden.txt")).toBe(true);
  });
});
