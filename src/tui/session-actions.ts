// The conversation as a whole: /new starts another, /sessions resumes an old one in place of this
// one, /fork moves the session's head back one message. The screen starts again with each.

import { dirname } from "node:path";
import type { Agent } from "../loop.ts";
import type { Session } from "../session.ts";
import { sessionDir } from "../session.ts";
import type { Message } from "../types.ts";
import type { Marker } from "./marker.ts";
import type { Menu } from "./menu.ts";
import type { RunView } from "./run-view.ts";
import type { SessionsHost } from "./sessions-menu.ts";
import type { SidePanel } from "./side.ts";

export interface SessionActionsOptions {
  session: Session | undefined;
  /** A new session for a new conversation, and the startup panel to print again. */
  create?: () => Promise<{ session: Session; intro: string }>;
  /** That session loaded in place of this one, and the startup panel to print again. */
  load?: (path: string) => Promise<{ session: Session; intro: string }>;
  /** The agent again after /fork moved the session's head. */
  rebuild?: () => Agent;
  agent: () => Agent;
  replaceAgent: (agent: Agent) => void;
  /** Where sessions are kept when there is none yet: per directory. */
  cwd: string;
  run: RunView;
  side: SidePanel;
  marker: Marker;
  menu: Menu;
  contextWindow: () => number;
  width: () => number;
  /** The screen wiped, then the startup panel, then (resuming) the conversation. */
  clearScreen: () => void;
  intro: (text: string) => void;
  replay: (messages: Message[], note: string) => void;
  closeMenu: () => void;
  render: () => void;
}

export class SessionActions {
  #opts: SessionActionsOptions;
  #session: Session | undefined;

  constructor(opts: SessionActionsOptions) {
    this.#opts = opts;
    this.#session = opts.session;
  }

  get session(): Session | undefined {
    return this.#session;
  }

  /** /new: a new session, the model with no history; counters and plan start again. */
  async startNew(): Promise<void> {
    const { run, marker } = this.#opts;
    if (run.running) return marker.warn("a run is going: Esc it first, then /new");
    if (this.#opts.create === undefined) return marker.warn("/new is not available here");
    const { session, intro } = await this.#opts.create();
    this.#session = session;
    run.reset();
    this.#opts.side.history([]);
    this.#opts.clearScreen();
    this.#opts.intro(intro);
    marker.inform("new session: the model starts with no history");
  }

  /** /sessions' R: that session's conversation, in place of this one (the model in use stays). */
  async resume(path: string): Promise<void> {
    const { run, marker } = this.#opts;
    if (run.running) return marker.warn("a run is going: Esc it first, then resume");
    const { session, intro } = (await this.#opts.load?.(path)) ?? {};
    if (session === undefined || intro === undefined) return;
    this.#session = session;
    run.reset();
    this.#opts.clearScreen();
    this.#opts.intro(intro);
    this.#opts.replay(this.#opts.agent().messages, `resumed session ${session.meta.id}`);
    marker.inform("resumed: the model has that conversation again");
  }

  /** /fork: the session's head back one message; a fork is only ever a pointer move. */
  async fork(): Promise<string> {
    const session = this.#session;
    if (session === undefined) return "fork: no session to fork";
    const branch = session.activeBranch();
    const head = branch.at(-1);
    if (head === undefined) return "fork: the session is empty";
    const target = branch.at(-2) ?? head;
    if (target.id === head.id) return "fork: already at the oldest message of this branch";
    await session.setHead(target.id);
    if (this.#opts.rebuild) this.#opts.replaceAgent(this.#opts.rebuild());
    return `fork: head moved from ${head.role} to ${target.role} (${branch.length} -> ${branch.length - 1} messages)`;
  }

  /** What the /sessions page needs: where they are, this one, and how to resume another. */
  menuHost(): SessionsHost {
    const { menu, run } = this.#opts;
    const s = this.#session;
    return {
      dir: s ? dirname(s.path) : sessionDir(this.#opts.cwd),
      current: s ? { id: s.meta.id, context: run.tokens.context, window: this.#opts.contextWindow() } : undefined,
      resume: this.#opts.load
        ? (path) => {
            this.#opts.closeMenu();
            void this.resume(path).then(() => this.#opts.render());
          }
        : undefined,
      width: this.#opts.width,
      open: (page) => {
        menu.open(page);
        this.#opts.render();
      },
      swap: (from, to) => {
        menu.swap(from, to);
        this.#opts.render();
      },
    };
  }
}
