// Extensions from a git repository (kinoko-extensions unless the config names another), one folder
// each, installed one by one into ~/.kinoko/ext/<name>/. The repository is kept with git in
// ~/.kinoko/registry/ (a shallow clone, updated on every listing). An extension with dependencies
// gets `bun install` in its own folder: kinoko itself stays without any.

import { cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_REPO = "https://github.com/LaraGuardiola/kinoko-extensions.git";

export interface ExtEntry {
  name: string;
  description: string;
  installed: boolean;
}

export interface ExtStore {
  /** Where the extensions come from, as the page names it. */
  readonly repo: string;
  /** Fetches the repository (a clone the first time, an update after) and lists its extensions. */
  list(signal: AbortSignal): Promise<ExtEntry[]>;
  /** Copies one into ~/.kinoko/ext/<name>/ (installing its dependencies); says what happened. */
  install(name: string, signal: AbortSignal): Promise<string>;
  /** Deletes an installed one; says what happened. */
  remove(name: string): Promise<string>;
}

/** Runs a command; its exit code and output (stdout then stderr). */
export type Run = (cmd: string[], cwd: string, signal: AbortSignal) => Promise<{ code: number; out: string }>;

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export const spawnRun: Run = async (cmd, cwd, signal) => {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const kill = (): void => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.removeEventListener("abort", kill);
    return { code: signal.aborted ? 130 : code, out: `${out}${err}`.trim() };
  } catch (e) {
    return { code: 127, out: e instanceof Error ? e.message : String(e) }; // git or bun is not installed
  }
};

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function json(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await Bun.file(path).json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The last line of a failed command: the one that says why. */
function why(out: string): string {
  return out.split("\n").findLast((line) => line.trim() !== "") ?? "no output";
}

export function extStore(opts: { home: string; repo?: string; run?: Run }): ExtStore {
  const repo = opts.repo || DEFAULT_REPO;
  const exec = opts.run ?? spawnRun;
  const kinoko = join(opts.home, ".kinoko");
  const registry = join(kinoko, "registry");
  const extDir = join(kinoko, "ext");

  /** Clones the repository, or brings the clone up to date; an error says why. */
  async function sync(signal: AbortSignal): Promise<void> {
    if (await exists(join(registry, ".git", "HEAD"))) {
      const url = await exec(["git", "-C", registry, "remote", "get-url", "origin"], kinoko, signal);
      if (url.code === 0 && url.out === repo) {
        const fetched = await exec(["git", "-C", registry, "fetch", "--depth", "1", "origin", "HEAD"], kinoko, signal);
        if (fetched.code !== 0) throw new Error(`could not update ${repo}: ${why(fetched.out)}`);
        const reset = await exec(["git", "-C", registry, "reset", "--hard", "--quiet", "FETCH_HEAD"], kinoko, signal);
        if (reset.code !== 0) throw new Error(`could not update ${repo}: ${why(reset.out)}`);
        return;
      }
      await rm(registry, { recursive: true, force: true }); // another repository now: start again
    }
    const cloned = await exec(["git", "clone", "--quiet", "--depth", "1", repo, registry], opts.home, signal);
    if (cloned.code !== 0) throw new Error(`could not fetch ${repo}: ${why(cloned.out)}`);
  }

  async function installed(name: string): Promise<boolean> {
    return (await exists(join(extDir, name, "index.ts"))) || (await exists(join(extDir, `${name}.ts`)));
  }

  async function names(): Promise<string[]> {
    const entries = await readdir(registry, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter((e) => e.isDirectory() && NAME.test(e.name) && e.name !== "node_modules" && e.name !== "testing").map((e) => e.name);
    const found = await Promise.all(dirs.map(async (name) => ((await exists(join(registry, name, "index.ts"))) ? name : undefined)));
    return found.filter((name) => name !== undefined).toSorted();
  }

  return {
    repo,

    async list(signal) {
      await sync(signal);
      return Promise.all(
        (await names()).map(async (name) => {
          const description = (await json(join(registry, name, "package.json"))).description;
          return { name, description: typeof description === "string" ? description : "", installed: await installed(name) };
        }),
      );
    },

    async install(name, signal) {
      if (!NAME.test(name) || !(await exists(join(registry, name, "index.ts")))) return `no extension called ${name} in ${repo}`;
      const was = await installed(name);
      const target = join(extDir, name);
      await rm(target, { recursive: true, force: true });
      await rm(join(extDir, `${name}.ts`), { force: true }); // an older single-file copy would load twice
      await cp(join(registry, name), target, {
        recursive: true,
        filter: (src) => !src.endsWith(".test.ts") && !src.split("/").includes("node_modules"),
      });
      const deps = (await json(join(target, "package.json"))).dependencies;
      if (typeof deps === "object" && deps !== null && Object.keys(deps).length > 0) {
        const result = await exec(["bun", "install", "--production"], target, signal);
        if (result.code !== 0) return `${name} copied, but its dependencies did not install: ${why(result.out)}`;
      }
      return `${name} ${was ? "updated" : "installed"}: restart kinoko to load it`;
    },

    async remove(name) {
      if (!NAME.test(name) || !(await installed(name))) return `${name} is not installed`;
      await rm(join(extDir, name), { recursive: true, force: true });
      await rm(join(extDir, `${name}.ts`), { force: true });
      return `${name} removed: gone when kinoko restarts`;
    },
  };
}
