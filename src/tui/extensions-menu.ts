// The pages that change what kinoko can do: /extensions and /skills (install, switch on and off,
// update, remove, from their repositories) and /profile (a named set of all of that at once).
// Whatever changes is put into effect now when it can be, and the startup panel follows.

import type { Catalog, Change, Entry, Outcome } from "../catalog.ts";
import type { CommandHost } from "../commands.ts";
import { applyProfile, currentProfile, readProfiles } from "../profiles.ts";
import type { FilesState, IntegrationsHost } from "./integrations-menu.ts";
import type { Marker } from "./marker.ts";
import type { ListPage, Menu } from "./menu.ts";
import { catalogPage } from "./menu-pages.ts";

/** Puts an install, a switch or a removal into effect now; says how. */
export type Apply = (kind: "extensions" | "skills", name: string, change: Change) => Promise<string>;

export interface ExtensionsMenuOptions {
  catalogs: { extensions?: Catalog; skills?: Catalog };
  /** Without it, a change takes effect when kinoko starts again. */
  apply?: Apply;
  /** Where profiles are read and written. */
  home: string;
  menu: Menu;
  marker: Marker;
  /** What a profile acts on (the same as the phone's commands). */
  commandHost: () => CommandHost;
  /** Something changed: the startup panel's [Capabilities] lines follow. */
  changed: () => Promise<void>;
  render: () => void;
}

export class ExtensionsMenu {
  #opts: ExtensionsMenuOptions;

  constructor(opts: ExtensionsMenuOptions) {
    this.#opts = opts;
  }

  /** A catalog's page: what is on disk at once, the repository's news after; install and remove. */
  openCatalog(which: "extensions" | "skills"): void {
    const { menu, marker } = this.#opts;
    const store = this.#opts.catalogs[which];
    const title = which === "skills" ? "Skills" : "Extensions";
    if (store === undefined) {
      menu.open({ kind: "info", title, lines: ["  not available in this mode"] });
      return;
    }
    const state: { repo: string; entries?: Entry[]; error?: string } = { repo: store.repo };
    const entry = (name: string): Entry | undefined => state.entries?.find((e) => e.name === name);
    // On disk first, then into effect: loaded now, or (without `apply`) at the next start.
    const settle = async (name: string, change: Change, done: Outcome): Promise<Outcome> => {
      if (!done.ok) return done;
      const apply = this.#opts.apply;
      const how = apply ? await apply(which, name, change).catch((e: unknown) => `not applied: ${errorText(e)}`) : "restart kinoko to apply it";
      return { ok: true, note: `${done.note}: ${how}` };
    };
    const install = (name: string): void => {
      marker.inform(`${entry(name)?.installed ? "updating" : "installing"} ${name}…`);
      void store
        .install(name, AbortSignal.timeout(300_000))
        .then((done) => settle(name, "install", done))
        .catch((e: unknown) => ({ ok: false, note: `${name} did not install: ${errorText(e)}` }))
        .then(({ ok, note }) => {
          marker.inform(note);
          const installed = entry(name);
          if (installed && ok) {
            installed.installed = true;
            installed.enabled = true;
          }
          redraw();
        });
    };
    // On or off, at once: loaded or taken back (a skill: told to the model), still installed.
    const toggle = (name: string, on: boolean): void => {
      void store
        .enable(name, on)
        .then((done) => settle(name, on ? "enable" : "disable", done))
        .then(({ ok, note }) => {
          marker.inform(note);
          const switched = entry(name);
          if (switched && ok) switched.enabled = on;
          redraw();
        });
    };
    const remove = (name: string): void => {
      void store
        .remove(name)
        .then((done) => settle(name, "remove", done))
        .then(({ ok, note }) => {
          marker.inform(note);
          const removed = entry(name);
          if (removed && ok) removed.installed = false;
          redraw();
        });
    };
    const actions = { install, toggle, update: install, remove };
    let page = catalogPage(title, state, actions);
    const redraw = (): void => {
      const next = catalogPage(title, state, actions);
      menu.swap(page, next); // the selection stays on the entry just acted on
      page = next;
      this.#opts.render();
    };
    menu.open(page);
    // What is on disk first (instant, and all there is offline), then the repository's news.
    void store
      .local()
      .then((entries) => {
        state.entries ??= entries;
        redraw();
        return store.list(AbortSignal.timeout(60_000));
      })
      .then((entries) => (state.entries = entries))
      .catch((e: unknown) => (state.error = errorText(e)))
      .then(redraw);
  }

  /** The profiles, the one in use marked; Enter switches to one (installs, switches, thinking, asks). */
  openProfiles(): void {
    const { menu, marker, home } = this.#opts;
    const loading: ListPage = { kind: "list", title: "Profiles", items: [], empty: "reading…", pick: () => undefined, stay: true };
    menu.open(loading);
    void Promise.all([readProfiles(home), currentProfile(home)]).then(([all, current]) => {
      menu.refresh(loading, {
        kind: "list",
        title: "Profiles",
        items: all.map((p) => ({ name: p.name, description: `${p.title} · ${p.description}`, current: p.name === current })),
        empty: "",
        hint: "Enter switches to it: what is on, how much it thinks, what it asks",
        pick: (item) => {
          const profile = all.find((p) => p.name === item.name);
          if (profile === undefined) return;
          marker.inform(`switching to ${profile.title}…`);
          void applyProfile(this.#opts.commandHost(), home, profile, AbortSignal.timeout(300_000))
            .catch((e: unknown) => `${profile.title}: ${errorText(e)}`)
            .then(async (note) => {
              await this.#opts.changed();
              marker.inform(note);
              this.#opts.render();
            });
        },
      });
      this.#opts.render();
    });
  }

  /** The telegram extension through the extensions catalog, as /extensions installs it: what
   *  /integrations switches on to send files. */
  telegram(): IntegrationsHost["filesExtension"] {
    const store = this.#opts.catalogs.extensions;
    if (store === undefined) return undefined;
    const NAME = "telegram";
    const state = async (): Promise<FilesState> => {
      const entry = (await store.local()).find((e) => e.name === NAME);
      return !entry?.installed ? "missing" : entry.enabled === false ? "off" : "on";
    };
    const apply = async (change: Change, done: Outcome): Promise<string> => {
      const into = this.#opts.apply;
      return done.ok && into ? `${done.note}: ${await into("extensions", NAME, change).catch((e: unknown) => `not applied: ${errorText(e)}`)}` : done.note;
    };
    return {
      state,
      turnOn: async () => {
        const signal = AbortSignal.timeout(300_000);
        if ((await state()) === "off") return apply("enable", await store.enable(NAME, true));
        await store.list(signal); // the newest catalog: an old copy may not have it yet
        return apply("install", await store.install(NAME, signal));
      },
    };
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
