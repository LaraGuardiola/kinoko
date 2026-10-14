// How much the model thinks before it answers: the level picked (/thinking, a profile, the phone),
// the label on the rule above the editor ("LOW · 2048"), and what the agent sends from then on.

import type { Agent } from "../loop.ts";
import { THINKING, profileLabel, thinkingPage } from "./menu-pages.ts";
import type { ThinkingProfile } from "./menu-pages.ts";
import type { ListPage } from "./menu.ts";

export interface ThinkingLevelOptions {
  agent: () => Agent;
  /** The label at start, and the level it is (THINKING's name) when the config matches one. */
  label?: string;
  name?: string;
  /** The engine takes a thinking token budget (llama.cpp, Strata): levels send one. */
  budgets: boolean;
  /** Says what was switched (the marker above the editor). */
  told: (note: string) => void;
}

export class ThinkingLevel {
  #opts: ThinkingLevelOptions;
  #label: string | undefined;
  #name: string | undefined;

  constructor(opts: ThinkingLevelOptions) {
    this.#opts = opts;
    this.#label = opts.label;
    this.#name = opts.name;
  }

  /** What the rule above the editor says. */
  get label(): string | undefined {
    return this.#label;
  }

  /** The level in effect (THINKING's name), when it is one of them. */
  get name(): string | undefined {
    return this.#name;
  }

  /** The /thinking page, the level in effect marked. */
  page(): ListPage {
    return thinkingPage(this.#name, (level) => this.choose(level));
  }

  /** Switches to a level by name (the phone's /thinking); says what was done. */
  chooseByName(name: string): string {
    const level = THINKING.find((p) => p.name === name);
    return level === undefined ? `no thinking profile ${name}` : this.choose(level);
  }

  /** Switches to a level from the next request; says what was done. */
  choose(level: ThinkingProfile): string {
    const budgets = this.#opts.budgets;
    // Only an engine that takes a budget gets one; elsewhere the effort alone is the level.
    this.#opts.agent().setThinking(level.effort, budgets ? level.budget : undefined);
    this.#name = level.name;
    this.#label = profileLabel(level, budgets);
    const note = `thinking: ${this.#label} from the next request`;
    this.#opts.told(note);
    return note;
  }
}
