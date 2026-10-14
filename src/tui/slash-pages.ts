// Where each item of the slash menu leads: a page of its own (thinking, models, extensions and
// skills, sessions, background jobs, integrations, profiles, code to copy), or the command of the
// same name, run at once (/help, /new, /compact…).

import type { Jobs } from "../jobs.ts";
import type { Agent } from "../loop.ts";
import { hubRunning, hubSocket } from "../serve/link.ts";
import { copyText } from "./clipboard.ts";
import type { ExtensionsMenu } from "./extensions-menu.ts";
import type { IntegrationsHost } from "./integrations-menu.ts";
import { openIntegrations } from "./integrations-menu.ts";
import { openJobs } from "./jobs-view.ts";
import type { Marker } from "./marker.ts";
import type { Menu, MenuItem, MenuPage } from "./menu.ts";
import { copyPage } from "./menu-pages.ts";
import type { ModelSwitch } from "./model-switch.ts";
import type { SessionActions } from "./session-actions.ts";
import { openSessions } from "./sessions-menu.ts";
import type { SlashMenu } from "./slash-menu.ts";
import { snippets } from "./snippets.ts";
import type { StartupPanel } from "./startup-panel.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export interface SlashPagesOptions {
  agent: () => Agent;
  menu: Menu;
  slash: () => SlashMenu;
  marker: Marker;
  thinking: ThinkingLevel;
  models: ModelSwitch;
  extensions: ExtensionsMenu;
  sessions: SessionActions;
  startup: StartupPanel;
  jobs?: Jobs;
  /** /integrations' fakes in tests; unset: the user's home, the real Telegram, the hub's socket. */
  integrations?: Partial<Pick<IntegrationsHost, "home" | "apiBase" | "hubRunning" | "filesExtension">>;
  home: string;
  /** The room a jobs window may take: the transcript's columns, the screen's rows. */
  room: () => { cols: number; rows: number };
  command: (input: string) => Promise<boolean>;
  /** Writes to the terminal (OSC 52: the copy reaches the clipboard over SSH too). */
  write: (data: string) => void;
  render: () => void;
}

export class SlashPages {
  #opts: SlashPagesOptions;

  constructor(opts: SlashPagesOptions) {
    this.#opts = opts;
  }

  /** Enter on an item of the root. */
  open(item: MenuItem): void {
    const { menu, thinking, models, extensions, sessions } = this.#opts;
    if (item.name === "thinking") menu.open(thinking.page());
    else if (item.name === "models") models.open();
    else if (item.name === "extensions" || item.name === "skills") extensions.openCatalog(item.name);
    else if (item.name === "sessions") openSessions(sessions.menuHost());
    else if (item.name === "jobs") this.openJobs();
    else if (item.name === "integrations") openIntegrations(this.#integrationsHost());
    else if (item.name === "profile") extensions.openProfiles();
    else if (item.name === "copy") menu.open(copyPage(snippets(this.#opts.agent().messages), (s) => this.copy(s.code)));
    else {
      this.#opts.slash().close();
      void this.#opts.command(`/${item.name}`).then(() => this.#opts.render());
    }
  }

  /** The background jobs: their list, and each one's window. */
  openJobs(): void {
    const jobs = this.#opts.jobs;
    if (jobs === undefined) {
      this.#opts.menu.open({ kind: "info", title: "Background jobs", lines: ["  not available in this mode"] });
      return;
    }
    openJobs({ jobs, ...this.#pageHost(), note: (text) => this.#note(text), size: this.#opts.room });
  }

  /** Puts text in the clipboard, and says how much. */
  copy(text: string): void {
    const lines = text.split("\n").length;
    this.#opts.marker.inform(`copied: ${lines} line${lines === 1 ? "" : "s"}`);
    void copyText(text, this.#opts.write, AbortSignal.timeout(5000));
  }

  #integrationsHost(): IntegrationsHost {
    const fakes = this.#opts.integrations;
    const home = fakes?.home ?? this.#opts.home;
    return {
      home,
      apiBase: fakes?.apiBase,
      ...this.#pageHost(),
      note: (text) => this.#note(text),
      changed: () => void this.#opts.startup.refresh(),
      hubRunning: fakes?.hubRunning ?? (() => hubRunning(hubSocket(home))),
      filesExtension: fakes?.filesExtension ?? this.#opts.extensions.telegram(),
    };
  }

  /** How a page of its own opens, and is redrawn in place. */
  #pageHost(): { open: (page: MenuPage) => void; swap: (from: MenuPage, to: MenuPage) => void } {
    const { menu, render } = this.#opts;
    return {
      open: (page) => {
        menu.open(page);
        render();
      },
      swap: (from, to) => {
        menu.swap(from, to);
        render();
      },
    };
  }

  #note(text: string): void {
    this.#opts.marker.inform(text);
    this.#opts.render();
  }
}
