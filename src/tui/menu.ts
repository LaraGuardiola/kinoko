// The slash menu. Typing "/" opens it under the input, between the lower rule and the place line:
// the root lists commands, filtered by what follows the slash. Enter opens a page (a list to pick
// from, or a table to read); Esc goes back to the root, and from the root closes the menu.

import { ANSI } from "./style.ts";

export interface MenuItem {
  name: string;
  description: string;
  /** The value in effect now (the current model, the current thinking profile). */
  current?: boolean;
}

export interface ListPage {
  kind: "list";
  title: string;
  items: MenuItem[];
  /** What to show while there are no items (still loading, or nothing to list). */
  empty: string;
  pick: (item: MenuItem) => void;
}

export interface InfoPage {
  kind: "info";
  title: string;
  lines: string[];
}

export type MenuPage = ListPage | InfoPage;

/** The colour of the startup panel's [Capabilities] heading. */
export const ORANGE = "\x1b[38;5;214m";
/** Items on screen at once; a longer list scrolls with the selection. */
export const MENU_ROWS = 8;

export class Menu {
  #page: MenuPage | undefined;
  #index = 0;

  /** The page open on top of the root, if any. */
  get page(): MenuPage | undefined {
    return this.#page;
  }

  get index(): number {
    return this.#index;
  }

  open(page: MenuPage): void {
    this.#page = page;
    this.#index = page.kind === "list" ? Math.max(0, page.items.findIndex((item) => item.current)) : 0;
  }

  /** Swaps the open page's items (a list that finished loading), keeping the selection in range. */
  refresh(page: ListPage): void {
    if (this.#page?.kind !== "list" || this.#page.title !== page.title) return;
    this.open(page);
  }

  /** Esc: a page goes back to the root (true); at the root there is nothing to go back to (false). */
  back(): boolean {
    if (this.#page === undefined) return false;
    this.#page = undefined;
    this.#index = 0;
    return true;
  }

  /** Back to a closed root, as after a pick. */
  close(): void {
    this.#page = undefined;
    this.#index = 0;
  }

  /** Up/down through `count` items, wrapping at both ends. */
  move(delta: number, count: number): void {
    if (count === 0) return;
    this.#index = (((this.#index + delta) % count) + count) % count;
  }

  /** Keeps the selection inside a root list that just got shorter (the filter narrowed). */
  clamp(count: number): void {
    this.#index = Math.max(0, Math.min(this.#index, count - 1));
  }
}

/** The root's items whose name starts with what was typed after the slash. */
export function filterRoot(items: MenuItem[], typed: string): MenuItem[] {
  const query = typed.replace(/^\//, "").toLowerCase();
  return items.filter((item) => item.name.startsWith(query));
}

/** A list as rows: the selection marked with an arrow, names in orange, descriptions dimmed. */
export function listRows(items: MenuItem[], selected: number, title?: string, empty = ""): string[] {
  const rows = title ? [`${ANSI.bold}${ORANGE}${title}${ANSI.reset}`] : [];
  if (items.length === 0) return [...rows, `  ${ANSI.dim}${empty}${ANSI.reset}`];
  const start = Math.min(Math.max(0, selected - Math.floor(MENU_ROWS / 2)), Math.max(0, items.length - MENU_ROWS));
  const width = Math.max(...items.map((item) => item.name.length)) + 4;
  for (const [i, item] of items.slice(start, start + MENU_ROWS).entries()) {
    const chosen = start + i === selected;
    const name = `${chosen ? ANSI.bold : ""}${ORANGE}${item.name.padEnd(width)}${ANSI.reset}`;
    const mark = item.current ? `${ORANGE}● ${ANSI.reset}` : "";
    rows.push(`${chosen ? `${ORANGE}→${ANSI.reset} ` : "  "}${name}${mark}${ANSI.dim}${item.description}${ANSI.reset}`);
  }
  rows.push(`  ${ANSI.dim}(${selected + 1}/${items.length})${ANSI.reset}`);
  return rows;
}

/** The open page as rows. */
export function pageRows(page: MenuPage, selected: number): string[] {
  if (page.kind === "list") return listRows(page.items, selected, page.title, page.empty);
  return [`${ANSI.bold}${ORANGE}${page.title}${ANSI.reset}`, ...page.lines, `  ${ANSI.dim}Esc to go back${ANSI.reset}`];
}
