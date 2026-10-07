import { expect, test, describe } from "bun:test";
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
