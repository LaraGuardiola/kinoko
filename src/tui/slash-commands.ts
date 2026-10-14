// The slash commands typed in the TUI (/help, /model, /compact, /fork, /clear, /new, /quit,
// /shell, and the ones extensions add), and what the phone's commands act on when this TUI is
// linked to kinoko serve: this TUI itself, so its screen follows what the phone changed.

import type { Catalog } from "../catalog.ts";
import type { CommandHost } from "../commands.ts";
import type { Jobs } from "../jobs.ts";
import type { Agent } from "../loop.ts";
import { modelName } from "../prompt.ts";
import type { Apply } from "./extensions-menu.ts";
import type { Marker } from "./marker.ts";
import { helpText, sessionLines } from "./menu-pages.ts";
import type { ModelSwitch } from "./model-switch.ts";
import type { RunView } from "./run-view.ts";
import type { Scrollback } from "./scrollback.ts";
import type { SessionActions } from "./session-actions.ts";
import type { StartupPanel } from "./startup-panel.ts";
import { ANSI, stripAnsi } from "./style.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export type ExtensionCommands = {
  list: () => Array<{ name: string; description: string }>;
  get: (name: string) => ((args: string) => string | Promise<string>) | undefined;
};

export interface SlashCommandsOptions {
  agent: () => Agent;
  scrollback: Scrollback;
  marker: Marker;
  models: ModelSwitch;
  sessions: SessionActions;
  run: RunView;
  thinking: ThinkingLevel;
  startup: StartupPanel;
  extensionCommands?: ExtensionCommands;
  jobs?: Jobs;
  catalogs: { extensions?: Catalog; skills?: Catalog };
  apply?: Apply;
  clearScreen: () => void;
  quit: () => void;
  /** The terminal lent to the user's shell: a command run there, or an interactive one. */
  shell: (command: string) => Promise<void>;
  render: () => void;
}

export class SlashCommands {
  #opts: SlashCommandsOptions;

  constructor(opts: SlashCommandsOptions) {
    this.#opts = opts;
  }

  /** Runs a slash command. Returns false when the name is unknown. */
  async run(input: string): Promise<boolean> {
    const { scrollback, marker, models, sessions, render } = this.#opts;
    const [name = ""] = input.replace(/^\//, "").split(" ");
    switch (name) {
      case "help":
        scrollback.print("system", helpText(scrollback.width), undefined, undefined, (w) => helpText(w));
        break;
      case "model":
        scrollback.print("system", `model: ${modelName(models.model)}  context: ${models.contextWindow} tokens`);
        break;
      case "compact":
        if (!(await this.#opts.agent().compactNow())) marker.warn("nothing to compact yet");
        break;
      case "fork":
        scrollback.print("system", await sessions.fork());
        break;
      case "clear":
        this.#opts.clearScreen();
        break;
      case "new":
        await sessions.startNew();
        break;
      case "quit":
        this.#opts.quit();
        return true;
      case "shell":
        await this.#opts.shell(input.replace(/^\/?shell\s*/, ""));
        return true;
      default:
        return this.#extensionCommand(name, input.replace(/^\/?\S+\s*/, ""));
    }
    render();
    return true;
  }

  /** What the phone's slash commands act on (through kinoko serve). */
  phoneHost(): CommandHost {
    const { scrollback, marker, models, sessions, thinking, render } = this.#opts;
    const agent = this.#opts.agent();
    const rendered = <T>(value: T): T => {
      render();
      return value;
    };
    return {
      agent,
      ...(this.#opts.jobs ? { jobs: this.#opts.jobs } : {}),
      catalogs: this.#opts.catalogs,
      apply: this.#opts.apply,
      newSession: async () => rendered(await sessions.startNew()),
      thinking: { current: () => thinking.name, set: (name) => rendered(thinking.chooseByName(name)) },
      models: { list: (signal) => models.list(signal), set: (name) => rendered(models.useByName(name)) },
      clear: () => rendered(this.#opts.clearScreen()),
      fork: async () => {
        const moved = await sessions.fork();
        scrollback.print("system", moved);
        return rendered(moved);
      },
      session: () => {
        const s = sessions.session;
        if (s === undefined) return "no session";
        const facts = { path: s.path, id: s.meta.id, created: s.meta.created, messages: agent.messages, context: this.#opts.run.tokens.context, window: models.contextWindow };
        return stripAnsi(sessionLines(facts, 60).join("\n"));
      },
      told: (note) => {
        marker.inform(note);
        void this.#opts.startup.refresh(); // a profile switched from the phone: the panel says which
        render();
      },
    };
  }

  /** An extension's command: what it answers, printed here; one that throws says so. */
  async #extensionCommand(name: string, args: string): Promise<boolean> {
    const { scrollback, render } = this.#opts;
    const run = this.#opts.extensionCommands?.get(name);
    if (run === undefined) return false;
    scrollback.print("system", `${ANSI.dim}/${name}${args ? ` ${args}` : ""}…${ANSI.reset}`);
    render();
    const answer = await Promise.resolve()
      .then(() => run(args))
      .catch((e: unknown) => `/${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    scrollback.print("system", answer);
    render();
    return true;
  }
}
