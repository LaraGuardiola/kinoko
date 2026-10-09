// "@" file references: typing @ in the input lists the directory being typed (the cwd at first),
// narrowed by what follows; the arrows pick, Tab or Enter completes. A directory opens in place, a
// file leaves "@path " in the text. Listing is async and cached per directory: it never blocks.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { MenuItem } from "./menu.ts";

/** At most this many entries are offered; typing narrows the rest. */
export const MAX_FILES = 200;

export interface Entry {
  name: string;
  dir: boolean;
}

/** The "@..." word that ends at the cursor: where it starts and what follows the @. */
export function atQuery(text: string, cursor: number): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor);
  const match = /(^|\s)@(\S*)$/.exec(before);
  if (match === null) return undefined;
  const query = match[2] ?? "";
  return { start: cursor - query.length - 1, query };
}

/** "src/tu" -> the directory part "src/" and the name prefix "tu". */
export function splitQuery(query: string): { dir: string; prefix: string } {
  const slash = query.lastIndexOf("/");
  return { dir: query.slice(0, slash + 1), prefix: query.slice(slash + 1) };
}

/** Entries matching the prefix (case-insensitive): name starts first, then contains; directories first. */
export function narrow(entries: Entry[], prefix: string): Entry[] {
  const p = prefix.toLowerCase();
  const hidden = !p.startsWith(".");
  const rank = (e: Entry): number => (e.name.toLowerCase().startsWith(p) ? 0 : 1);
  return entries
    .filter((e) => !(hidden && e.name.startsWith(".")) && e.name.toLowerCase().includes(p))
    .toSorted((a, b) => rank(a) - rank(b) || Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, MAX_FILES);
}

export type Lister = (dir: string) => Promise<Entry[]>;

export const listDir: Lister = async (dir) => {
  const dirents = await readdir(dir, { withFileTypes: true });
  return dirents.map((d) => ({ name: d.name, dir: d.isDirectory() }));
};

/** The picker's state: the token it is for, the listing, the selection. */
export class FilePicker {
  #cwd: string;
  #list: Lister;
  #onChange: () => void;
  #cache = new Map<string, Entry[] | "loading" | "failed">();
  #token: { start: number; query: string } | undefined;
  #dismissed: number | undefined; // Esc closed the picker for the token starting here
  #index = 0;

  constructor(cwd: string, onChange: () => void, list: Lister = listDir) {
    this.#cwd = cwd;
    this.#onChange = onChange;
    this.#list = list;
  }

  /** Follows the editor: called with its text and cursor whenever they may have changed. */
  sync(text: string, cursor: number): void {
    const token = atQuery(text, cursor);
    // A fresh "@" reads the directories again: files come and go between two references.
    if (this.#token === undefined && token !== undefined) this.#cache.clear();
    if (token?.start !== this.#token?.start || token?.query !== this.#token?.query) this.#index = 0;
    if (token === undefined || token.start !== this.#dismissed) this.#dismissed = undefined;
    this.#token = token;
    if (token !== undefined) this.#load(splitQuery(token.query).dir);
  }

  get open(): boolean {
    return this.#token !== undefined && this.#dismissed === undefined;
  }

  get index(): number {
    return this.#index;
  }

  /** The directory as typed, for the title ("./" for the cwd). */
  get where(): string {
    return this.#token === undefined ? "" : splitQuery(this.#token.query).dir || "./";
  }

  /** What to show: matches, or undefined while the directory is still being read. */
  get entries(): Entry[] | undefined {
    if (this.#token === undefined) return [];
    const { dir, prefix } = splitQuery(this.#token.query);
    const cached = this.#cache.get(this.#path(dir));
    if (cached === "loading") return undefined;
    if (cached === "failed" || cached === undefined) return [];
    return narrow(cached, prefix);
  }

  items(): MenuItem[] {
    return (this.entries ?? []).map((e) => ({ name: e.dir ? `${e.name}/` : e.name, description: "" }));
  }

  move(delta: number): void {
    const count = this.entries?.length ?? 0;
    if (count > 0) this.#index = (((this.#index + delta) % count) + count) % count;
  }

  dismiss(): void {
    this.#dismissed = this.#token?.start;
  }

  /**
   * The selected entry as an edit: replace [start, end) with `text`. A directory keeps the picker
   * open on its contents; a file ends with a space, which closes it.
   */
  accept(): { start: number; end: number; text: string } | undefined {
    const token = this.#token;
    const entry = this.entries?.[this.#index];
    if (token === undefined || entry === undefined) return undefined;
    const { dir } = splitQuery(token.query);
    const path = `${dir}${entry.name}${entry.dir ? "/" : " "}`;
    return { start: token.start, end: token.start + 1 + token.query.length, text: `@${path}` };
  }

  #path(dir: string): string {
    // resolve: one spelling per directory ("src/" and "src" are one cache entry); absolute stays.
    return dir.startsWith("~/") ? resolve(homedir(), dir.slice(2)) : resolve(this.#cwd, dir);
  }

  #load(dir: string): void {
    const path = this.#path(dir);
    if (this.#cache.has(path)) return;
    this.#cache.set(path, "loading");
    void this.#list(path)
      .then((entries) => this.#cache.set(path, entries))
      .catch(() => this.#cache.set(path, "failed"))
      .finally(() => this.#onChange());
  }
}
