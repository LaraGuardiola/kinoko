// The lists at the foot of the live region and the keys and mouse they take: the slash menu (its
// root of commands while "/…" is typed, and a page open on top of it: models, extensions,
// sessions…) and the "@" file list that completes a path being typed.

import type { Editor } from "./editor.ts";
import type { FilePicker } from "./files.ts";
import { MENU_ROWS, filterRoot, listRows, listWindow, pageRows } from "./menu.ts";
import type { Menu, MenuItem } from "./menu.ts";
import { ROOT } from "./menu-pages.ts";
import type { Key } from "./term.ts";

export interface SlashMenuOptions {
  menu: Menu;
  editor: Editor;
  files: FilePicker;
  /** The commands extensions add to the root, after the built-in ones. */
  extensionCommands: () => Array<{ name: string; description: string }>;
  /** Where the live region starts on screen, and how many rows it has now (for the mouse). */
  regionTop: () => number | undefined;
  regionRows: () => number;
  /** The cwd line sits under the menu when there is one. */
  hasPlace: () => boolean;
  /** Enter on one of the root's commands. */
  openRoot: (item: MenuItem) => void;
  /** The menu was closed: what changed off screen meanwhile can be printed now. */
  closed: () => void;
  render: () => void;
}

export class SlashMenu {
  #opts: SlashMenuOptions;

  constructor(opts: SlashMenuOptions) {
    this.#opts = opts;
  }

  /** The menu is on screen: the mouse is kinoko's then (clicks pick, the wheel moves). */
  get showing(): boolean {
    return this.#opts.menu.page !== undefined || (this.#rootItems()?.length ?? 0) > 0;
  }

  /** Its rows, as the live region draws them (none when nothing is open). */
  rows(): string[] {
    const { menu, editor, files } = this.#opts;
    const page = menu.page;
    if (page) return pageRows(page, menu.index, menu.text, menu.armed);
    const items = this.#rootItems() ?? [];
    menu.clamp(items.length);
    if (items.length > 0) return listRows(items, menu.index);
    files.sync(editor.text, editor.cursor);
    if (!files.open) return [];
    const empty = files.entries === undefined ? "reading…" : "no matches";
    return listRows(files.items(), files.index, `Files · ${files.where}`, empty, undefined, "Tab or Enter to complete · Esc to close");
  }

  /** The keys the menu, or the file list, takes while open; false hands the key on. */
  key(key: Key): boolean {
    return this.#menuKey(key) || this.#fileKey(key);
  }

  /** The wheel moves through the open menu; hovering selects; a click picks, as Enter would. */
  mouse(key: Key): void {
    const m = key.mouse;
    if (m === undefined) return;
    if (m.wheel !== undefined) {
      this.#menuKey({ name: m.wheel === "up" ? "up" : "down" });
      return;
    }
    const index = this.#itemAt(m.y);
    if (index === undefined) return;
    const menu = this.#opts.menu;
    if (m.move) {
      if (index !== menu.index) {
        menu.select(index);
        this.#opts.render();
      }
      return;
    }
    if (!m.press || m.button !== 0) return;
    menu.select(index);
    this.#menuKey({ name: "enter" });
  }

  /** Closes it, and the "/…" that opened it goes from the editor. */
  close(): void {
    this.#opts.menu.close();
    this.#opts.editor.clear();
    this.#opts.closed();
  }

  /** The root is open while the editor holds only a slash command being typed. */
  #rootItems(): MenuItem[] | undefined {
    const { menu, editor } = this.#opts;
    if (menu.page !== undefined || !/^\/\S*$/.test(editor.text)) return undefined;
    // The built-in ones, then what extensions add (a built-in name keeps its own).
    const added = this.#opts.extensionCommands().filter((c) => !ROOT.some((r) => r.name === c.name));
    return filterRoot([...ROOT, ...added], editor.text);
  }

  #menuKey(key: Key): boolean {
    const { menu, editor } = this.#opts;
    const page = menu.page;
    const items = page ? [] : (this.#rootItems() ?? []);
    if (!page && items.length === 0) return false;
    const count = page?.kind === "list" ? page.items.length : items.length;
    const letter = key.name === "char" ? (key.char?.toLowerCase() ?? "") : "";
    const selected = page?.kind === "list" ? page.items[menu.index] : undefined;
    if (page?.kind === "input" && key.name !== "escape") {
      // An input page takes the typing; Enter hands the text over (it may open the next step).
      if (key.name === "char" || key.name === "paste") menu.type(key.char ?? "");
      else if (key.name === "backspace") menu.erase();
      else if (key.name === "enter") page.submit(menu.text);
      else if (key.name === "ctrl-c") this.close();
    } else if (page?.kind === "list" && page.remove && (key.name === "delete" || key.name === "backspace")) {
      // Del twice on a removable item: the first arms it, the second removes it.
      if (selected?.removable && selected.key !== undefined) {
        if (menu.armed === selected.key) page.remove(selected);
        else menu.arm(selected.key);
      }
    } else if (page?.kind === "info" && page.keys?.[letter]) {
      page.keys[letter]?.();
    } else if (page?.kind === "list" && page.keys?.[letter]) {
      // A letter that acts on the selected item (D: a model made the default).
      if (selected !== undefined && !selected.header) page.keys[letter]?.(selected);
    } else if (page?.kind === "list" && page.update && letter === "u") {
      if (selected !== undefined && !selected.header) page.update(selected);
    } else if ((key.name === "up" || key.name === "down") && !key.alt) {
      menu.arm(undefined); // moving away cancels a pending removal
      menu.move(key.name === "up" ? -1 : 1, count, (i) => page?.kind === "list" && page.items[i]?.header === true);
    } else if (key.name === "escape") {
      // A page goes back to the root; the root closes, back to an empty input.
      if (!menu.back()) {
        editor.clear();
        this.#opts.closed();
      }
    } else if (key.name === "enter" && !key.alt) {
      if (page?.kind === "list") {
        if (selected === undefined || selected.header) return true;
        page.pick(selected);
        // A pick that opened another page (add a model) keeps the menu, as does a page that stays
        // (switching things on and off); any other pick is done.
        if (menu.page === page && !page.stay) this.close();
      } else if (page?.kind === "info" && page.next) {
        page.next();
      } else if (page) {
        menu.back();
      } else {
        this.#opts.openRoot(items[menu.index]!);
      }
    } else if (page === undefined) {
      menu.close(); // typing narrows the root: start again from its first item
      return false;
    } else if (key.name === "ctrl-c") {
      this.close();
    } // a page takes no typing
    this.#opts.render();
    return true;
  }

  /** The keys the "@" file list takes while it is open: arrows, Tab/Enter to complete, Esc. */
  #fileKey(key: Key): boolean {
    const { editor, files } = this.#opts;
    files.sync(editor.text, editor.cursor);
    if (!files.open || key.alt) return false;
    if (key.name === "up" || key.name === "down") {
      files.move(key.name === "up" ? -1 : 1);
    } else if (key.name === "tab" || key.name === "enter") {
      const edit = files.accept();
      if (edit === undefined) return key.name === "tab"; // nothing to complete: Enter sends as usual
      const text = editor.text;
      editor.setText(text.slice(0, edit.start) + edit.text + text.slice(edit.end), edit.start + edit.text.length);
    } else if (key.name === "escape") {
      files.dismiss();
    } else {
      return false;
    }
    this.#opts.render();
    return true;
  }

  /** The menu item on screen row `y`, if there is one. */
  #itemAt(y: number): number | undefined {
    const menu = this.#opts.menu;
    const top = this.#opts.regionTop();
    const page = menu.page;
    const items = page?.kind === "list" ? page.items : page === undefined ? (this.#rootItems() ?? []) : undefined;
    if (top === undefined || items === undefined) return undefined;
    // The menu sits at the region's foot: its rows, then the place line (if any), then the status.
    const end = top + this.#opts.regionRows() - 1 - 1 - (this.#opts.hasPlace() ? 1 : 0);
    const row = y - (end - this.rows().length + 1) - (page === undefined ? 0 : 1); // a page's first row is its title
    const index = listWindow(items.length, menu.index) + row;
    if (row < 0 || row >= Math.min(items.length, MENU_ROWS) || items[index] === undefined || items[index]?.header) return undefined;
    return index;
  }
}
