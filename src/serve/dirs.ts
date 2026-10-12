// A path typed on the phone, completed here: the folders that start with what was typed, so an agent
// can start anywhere on this computer, not only where kinoko has worked before.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** `~` and `~/x` as this user's home; anything else made absolute. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

/** The folders that complete `typed`: inside it when it ends in "/", else its siblings starting with
 *  its last part (any case). Hidden ones only when that part starts with ".". */
export async function folders(typed: string, home = homedir(), limit = 50): Promise<string[]> {
  const full = expandHome(typed.trim() || "~", home);
  const inside = typed.endsWith("/") || typed.trim() === "~" || typed.trim() === "";
  const parent = inside ? full : dirname(full);
  const prefix = inside ? "" : full.slice(parent.length).replace(/^\//, "").toLowerCase();
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
    .map((e) => join(parent, e.name))
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, limit);
}
