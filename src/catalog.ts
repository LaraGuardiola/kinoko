// Catalogs: things kinoko can install one by one from a git repository, one folder each.
// Extensions come from kinoko-extensions into ~/.kinoko/ext/<name>/, skills from kinoko-skills
// into ~/.kinoko/skills/<name>/ (another repository when the config names one). Each repository
// is a shallow clone in ~/.kinoko/registry/<kind>/, updated on every listing. A folder with
// dependencies gets `bun install` in itself: kinoko stays without any.

import { cp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { frontmatter } from "./context.ts";
import { readDisabled, setDisabled } from "./disabled.ts";
import type { Toggleable } from "./disabled.ts";
import { extensionPlatforms, platformsLabel, platformsOf, runsHere } from "./platforms.ts";

/** What sets one catalog apart from another. */
export interface Kind {
  /** The registry folder and the page's name ("extensions"). */
  name: string;
  /** One of them, in messages ("extension"). */
  one: string;
  /** Where they are installed, under ~/.kinoko. */
  dir: string;
  /** The file that makes a folder one of them ("index.ts", "SKILL.md"). */
  entry: string;
  /** The repository when the config names none. */
  repo: string;
  /** Its description, read from its folder. */
  describe: (folder: string) => Promise<string>;
  /** The systems it works on (none: everywhere), read from its folder. */
  platforms: (folder: string) => Promise<string[] | undefined>;
  /** Older single-file installs (`name.ts`) count as installed: extensions only. */
  single?: string;
  /** A folder under home that kinoko also loads from but leaves to others (skills: ~/.agents/skills,
   *  shared with other agents): listed, never installed into or removed from. */
  shared?: string;
}

export const EXTENSIONS: Kind = {
  name: "extensions",
  one: "extension",
  dir: "ext",
  entry: "index.ts",
  repo: "https://github.com/LaraGuardiola/kinoko-extensions.git",
  describe: async (folder) => text((await json(join(folder, "package.json"))).description),
  platforms: extensionPlatforms,
  single: ".ts",
};

export const SKILLS: Kind = {
  name: "skills",
  one: "skill",
  dir: "skills",
  entry: "SKILL.md",
  repo: "https://github.com/LaraGuardiola/kinoko-skills.git",
  shared: ".agents/skills",
  describe: async (folder) => frontmatter(await Bun.file(join(folder, "SKILL.md")).text().catch(() => "")).description ?? "",
  platforms: async (folder) => platformsOf(frontmatter(await Bun.file(join(folder, "SKILL.md")).text().catch(() => "")).platforms),
};

export interface Entry {
  name: string;
  description: string;
  installed: boolean;
  /** Installed and not switched off (disabled.json): kinoko loads it. */
  enabled?: boolean;
  /** Found in the kind's shared folder: kinoko loads it, others manage it. */
  shared?: boolean;
  /** The systems it works on, when not all; `here` false: not this one (not loaded, not installed). */
  platforms?: string[];
  here?: boolean;
}

export interface Catalog {
  readonly kind: Kind;
  /** Where they come from, as the page names it. */
  readonly repo: string;
  /** With no network: the last fetched copy's entries, and the installed ones it lacks. */
  local(): Promise<Entry[]>;
  /** Fetches the repository (a clone the first time, an update after), then lists as `local`. */
  list(signal: AbortSignal): Promise<Entry[]>;
  /** Copies one into ~/.kinoko/<dir>/<name>/ (installing its dependencies); says what happened. */
  install(name: string, signal: AbortSignal): Promise<Outcome>;
  /** Deletes an installed one; says what happened. */
  remove(name: string): Promise<Outcome>;
  /** Switches an installed one on or off, without uninstalling it. */
  enable(name: string, on: boolean): Promise<Outcome>;
}

/** What a catalog's page did to an entry, for kinoko to put into effect. */
export type Change = "install" | "remove" | "enable" | "disable";

/** What an install or a removal did: `ok` when it is on disk as asked, and a line saying so. */
export interface Outcome {
  ok: boolean;
  note: string;
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

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The last line of a failed command: the one that says why. */
function why(out: string): string {
  return out.split("\n").findLast((line) => line.trim() !== "") ?? "no output";
}

const byName = (a: Entry, b: Entry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The entries in `dir`: folders with the kind's entry file, and, with `single`, `name.ts` files. */
async function names(kind: Kind, dir: string, single = false): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const suffix = single ? kind.single : undefined;
  const files = suffix ? entries.filter((e) => e.isFile() && e.name.endsWith(suffix)).map((e) => e.name.slice(0, -suffix.length)) : [];
  // A link counts when it leads to a folder with the entry file (Omarchy links its skills in).
  const dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && NAME.test(e.name) && e.name !== "node_modules" && e.name !== "testing").map((e) => e.name);
  const found = await Promise.all(dirs.map(async (name) => ((await exists(join(dir, name, kind.entry))) ? name : undefined)));
  return [...new Set([...found.filter((name) => name !== undefined), ...files])].toSorted();
}

export function catalog(opts: { kind: Kind; home: string; repo?: string; run?: Run }): Catalog {
  const { kind } = opts;
  const repo = opts.repo || kind.repo;
  const exec = opts.run ?? spawnRun;
  const kinoko = join(opts.home, ".kinoko");
  const registry = join(kinoko, "registry", kind.name);
  const target = join(kinoko, kind.dir);
  const legacy = (name: string): string | undefined => (kind.single ? join(target, `${name}${kind.single}`) : undefined);
  const shared = kind.shared ? join(opts.home, kind.shared) : undefined;

  /** Clones the repository, or brings the clone up to date; an error says why. The last fetched
   *  copy is never lost to a failure: offline, it is all the page has. */
  async function sync(signal: AbortSignal): Promise<void> {
    if (await exists(join(registry, ".git", "HEAD"))) {
      const url = await exec(["git", "-C", registry, "remote", "get-url", "origin"], kinoko, signal);
      if (url.code !== 0 || url.out === repo) {
        const fetched = await exec(["git", "-C", registry, "fetch", "--depth", "1", "origin", "HEAD"], kinoko, signal);
        if (fetched.code !== 0) throw new Error(`could not update ${repo}: ${why(fetched.out)}`);
        const reset = await exec(["git", "-C", registry, "reset", "--hard", "--quiet", "FETCH_HEAD"], kinoko, signal);
        if (reset.code !== 0) throw new Error(`could not update ${repo}: ${why(reset.out)}`);
        return;
      }
    }
    // First time, or another repository now: a fresh clone beside, swapped in once it is complete.
    const fresh = `${registry}.new`;
    await rm(fresh, { recursive: true, force: true });
    const cloned = await exec(["git", "clone", "--quiet", "--depth", "1", repo, fresh], opts.home, signal);
    if (cloned.code !== 0) {
      await rm(fresh, { recursive: true, force: true });
      throw new Error(`could not fetch ${repo}: ${why(cloned.out)}`);
    }
    await rm(registry, { recursive: true, force: true });
    await rename(fresh, registry);
  }

  async function installed(name: string): Promise<boolean> {
    const old = legacy(name);
    return (await exists(join(target, name, kind.entry))) || (old !== undefined && (await exists(old)));
  }

  async function local(): Promise<Entry[]> {
    const offered = await names(kind, registry);
    const fromRepo = await Promise.all(offered.map(async (name) => ({ name, description: await kind.describe(join(registry, name)), installed: await installed(name) })));
    // Installed but not offered (a hand-made one, or never fetched yet): still listed, removable.
    const own = (await names(kind, target, true)).filter((name) => !offered.includes(name));
    const mine = await Promise.all(own.map(async (name) => ({ name, description: (await kind.describe(join(target, name))) || "installed, not in the repository", installed: true })));
    // The shared folder's ones load too (the first of a name wins, as in discovery): shown, left alone.
    const taken = new Set([...offered, ...own]);
    const others = shared === undefined ? [] : (await names(kind, shared)).filter((name) => !taken.has(name));
    const theirs = await Promise.all(others.map(async (name) => ({ name, description: await kind.describe(join(shared ?? "", name)), installed: true, shared: true })));
    const off = new Set((await readDisabled(opts.home))[kind.name as Toggleable] ?? []);
    const folderOf = (e: Entry): string => join(e.shared ? (shared ?? "") : offered.includes(e.name) ? registry : target, e.name);
    const all: Entry[] = [...fromRepo, ...mine, ...theirs];
    const systems = await Promise.all(all.map((e) => kind.platforms(folderOf(e))));
    return all
      .map((e, i): Entry => {
        const platforms = systems[i];
        return Object.assign(e, { enabled: e.installed && !off.has(e.name) }, platforms ? { platforms, here: runsHere(platforms) } : {});
      })
      .toSorted(byName);
  }

  return {
    kind,
    repo,
    local,

    async list(signal) {
      await sync(signal);
      return local();
    },

    async install(name, signal) {
      if (!NAME.test(name) || !(await exists(join(registry, name, kind.entry)))) {
        if (shared !== undefined && NAME.test(name) && (await exists(join(shared, name, kind.entry))))
          return { ok: false, note: `${name} lives in ~/${kind.shared}, shared with other agents: kinoko leaves it alone` };
        return { ok: false, note: `no ${kind.one} called ${name} in ${repo}` };
      }
      const platforms = await kind.platforms(join(registry, name));
      if (!runsHere(platforms)) return { ok: false, note: `${name} is for ${platformsLabel(platforms ?? [])}: not this system` };
      const was = await installed(name);
      const folder = join(target, name);
      await rm(folder, { recursive: true, force: true });
      const old = legacy(name);
      if (old !== undefined) await rm(old, { force: true }); // an older single-file copy would load twice
      await cp(join(registry, name), folder, {
        recursive: true,
        filter: (src) => !src.endsWith(".test.ts") && !src.split(/[\\/]/).includes("node_modules"),
      });
      const deps = (await json(join(folder, "package.json"))).dependencies;
      if (typeof deps === "object" && deps !== null && Object.keys(deps).length > 0) {
        const result = await exec(["bun", "install", "--production"], folder, signal);
        if (result.code !== 0) return { ok: false, note: `${name} copied, but its dependencies did not install: ${why(result.out)}` };
      }
      return { ok: true, note: `${name} ${was ? "updated" : "installed"}` };
    },

    async remove(name) {
      if (!NAME.test(name) || !(await installed(name))) return { ok: false, note: `${name} is not installed` };
      await rm(join(target, name), { recursive: true, force: true });
      const old = legacy(name);
      if (old !== undefined) await rm(old, { force: true });
      await setDisabled(opts.home, kind.name as Toggleable, name, false); // a later install starts on
      return { ok: true, note: `${name} removed` };
    },

    async enable(name, on) {
      const here = NAME.test(name) && ((await installed(name)) || (shared !== undefined && (await exists(join(shared, name, kind.entry)))));
      if (!here) return { ok: false, note: `${name} is not installed` };
      await setDisabled(opts.home, kind.name as Toggleable, name, !on);
      return { ok: true, note: `${name} ${on ? "on" : "off"}` };
    },
  };
}
