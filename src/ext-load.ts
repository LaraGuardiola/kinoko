// Loading extensions: from ~/.kinoko/ext and <cwd>/.kinoko/ext at start, in an order that is the
// same on every machine, and one at a time while kinoko runs (/extensions installs, reloads).

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniqueDirs } from "./context.ts";
import { readDisabled } from "./disabled.ts";
import { errText } from "./ext.ts";
import type { ExtensionFactory, Extensions } from "./ext.ts";
import { userHome } from "./home.ts";
import { extensionPlatforms, runsHere } from "./platforms.ts";

export interface LoadOptions {
  cwd: string;
  home?: string;
}

/**
 * User extensions first, then project ones, each directory in name order, so load order (and
 * therefore who wins a command name) is the same on every machine. Imported in parallel, then run
 * in that order.
 */
export async function loadExtensions(k: Extensions, opts: LoadOptions): Promise<string[]> {
  const home = opts.home ?? userHome();
  const dirs = uniqueDirs([join(home, ".kinoko", "ext"), join(opts.cwd, ".kinoko", "ext")]);
  const off = new Set((await readDisabled(home)).extensions); // switched off in /extensions
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of listEntries(dir)) if (!off.has(extensionName(join(dir, name)))) paths.push(join(dir, name));
  }
  // Another system's (package.json "os"): not loaded, so none of its tools reach the model.
  const here = await Promise.all(paths.map(async (path) => runsHere(await extensionPlatforms(dirname(path)))));
  for (const [i, path] of paths.entries()) if (!here[i]) k.log(`${extensionName(path)} is not for this system: not loaded`);
  const mods = await Promise.all(paths.map((path, i) => (here[i] ? importDefault(path, k) : null)));
  const loaded: string[] = [];
  for (const [index, factory] of mods.entries()) {
    const path = paths[index];
    if (factory === null || path === undefined) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- factories run in load order on purpose
      await k.start(extensionName(path), factory);
      loaded.push(path);
    } catch (e) {
      k.log(`failed to start ${path}: ${errText(e)}`);
    }
  }
  return loaded;
}

/** `name.ts` files and `name/index.ts` folders, in name order. */
function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) // the same order on every machine
      .flatMap((e) => (e.isFile() && e.name.endsWith(".ts") ? [e.name] : e.isDirectory() && existsSync(join(dir, e.name, "index.ts")) ? [join(e.name, "index.ts")] : []));
  } catch {
    return [];
  }
}

/** What an extension is called: its file without `.ts`, or its folder. */
export function extensionName(path: string): string {
  const parts = path.split(/[\\/]/); // either separator: Windows paths too
  const file = parts.at(-1) ?? path;
  return (file === "index.ts" ? (parts.at(-2) ?? file) : file).replace(/\.ts$/, "");
}

let reloads = 0;

/**
 * (Re)loads one extension while kinoko runs: imported afresh (an updated file is read again), then
 * the old copy's registrations are taken back and the new one starts. An extension that fails to
 * import leaves the old copy running. Returns why it did not load, or undefined.
 */
export async function loadOne(k: Extensions, path: string): Promise<string | undefined> {
  const factory = await importDefault(path, k, `${path}?v=${Date.now()}-${++reloads}`); // a new module, not the cached one
  if (factory === null) return `${extensionName(path)} did not load (see the log)`;
  const name = extensionName(path);
  k.unload(name);
  try {
    await k.start(name, factory);
    return undefined;
  } catch (e) {
    k.unload(name);
    return `${name} did not start: ${errText(e)}`;
  }
}

async function importDefault(path: string, k: Extensions, specifier = path): Promise<null | ExtensionFactory> {
  try {
    const mod = (await import(specifier)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      k.log(`${path} has no default export, skipping`);
      return null;
    }
    return mod.default as ExtensionFactory;
  } catch (e) {
    k.log(`failed to load ${path}: ${errText(e)}`);
    return null;
  }
}