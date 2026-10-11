// Extensions and skills switched off from their menu page, without uninstalling them:
// ~/.kinoko/disabled.json, `{ "extensions": [...], "skills": [...] }`. Loading and discovery skip
// them; switching one back on loads it again, at once.

import { join } from "node:path";

export type Toggleable = "extensions" | "skills";

type Disabled = Record<Toggleable, string[]>;

function file(home: string): string {
  return join(home, ".kinoko", "disabled.json");
}

export async function readDisabled(home: string): Promise<Disabled> {
  try {
    const data = (await Bun.file(file(home)).json()) as Partial<Disabled>;
    return { extensions: Array.isArray(data.extensions) ? data.extensions : [], skills: Array.isArray(data.skills) ? data.skills : [] };
  } catch {
    return { extensions: [], skills: [] };
  }
}

/** Switches one off (`off` true) or back on. */
export async function setDisabled(home: string, kind: Toggleable, name: string, off: boolean): Promise<void> {
  const all = await readDisabled(home);
  const rest = all[kind].filter((n) => n !== name);
  all[kind] = off ? [...rest, name].toSorted() : rest;
  await Bun.write(file(home), `${JSON.stringify(all, null, 2)}\n`);
}
