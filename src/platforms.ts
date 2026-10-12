// Where an extension or a skill works. An extension says it in its package.json the npm way ("os":
// ["linux", "darwin"]); a skill in its SKILL.md frontmatter (platforms: linux, macos). Saying
// nothing means everywhere. What does not work here is not loaded (no tools, no line in the skills
// index: no prompt spent on it), cannot be installed, and a profile passes it by.

import { join } from "node:path";

const ALIASES: Record<string, string> = { linux: "linux", darwin: "darwin", macos: "darwin", mac: "darwin", osx: "darwin", win32: "win32", windows: "win32", win: "win32" };
const NAMES: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** The systems named, as Node names them; undefined when none is (everywhere). */
export function platformsOf(raw: unknown): string[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.replace(/^\[|\]$/g, "").split(/[,\s]+/) : [];
  const known = [...new Set(list.map((p) => ALIASES[String(p).trim().toLowerCase()]).filter((p): p is string => p !== undefined))];
  return known.length > 0 ? known : undefined;
}

/** Whether it works on this system: everything that names none does. */
export function runsHere(platforms: string[] | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return platforms === undefined || platforms.includes(platform);
}

/** "Linux only", "Linux and macOS": what the lists show beside one that does not work here. */
export function platformsLabel(platforms: string[]): string {
  const names = platforms.map((p) => NAMES[p] ?? p);
  return names.length === 1 ? `${names[0]} only` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** An extension folder's systems (package.json "os"); undefined: everywhere, or no package.json. */
export async function extensionPlatforms(folder: string): Promise<string[] | undefined> {
  const pkg = (await Bun.file(join(folder, "package.json"))
    .json()
    .catch(() => ({}))) as { os?: unknown };
  return platformsOf(pkg.os);
}
