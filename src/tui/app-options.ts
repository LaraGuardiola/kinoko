// What the TUI is given to work with: the agent, where it writes, the model and the session it
// starts with, and the hooks into the rest of kinoko (extensions, skills, jobs, sessions, the
// shell). Tests pass fakes for the ones that reach outside (clipboard, git, Telegram).

import type { Catalog, Change } from "../catalog.ts";
import type { Jobs } from "../jobs.ts";
import type { Agent } from "../loop.ts";
import type { Session } from "../session.ts";
import type { Image } from "../types.ts";
import type { IntegrationsHost } from "./integrations-menu.ts";
import type { ModelsHost } from "./model-switch.ts";
import type { ChangesSource } from "./side.ts";
import type { ExtensionCommands } from "./slash-commands.ts";

export interface AppOptions {
  agent: Agent;
  /** Started with no model set up anywhere: the status says so, and a prompt leads to /models. */
  noModel?: boolean;
  /** The messages sent in earlier runs (↑ brings them back), and where to keep each new one. */
  history?: { sent: string[]; add: (text: string) => void };
  /** Extensions' keys (Ctrl+Space) and their word that the user asked for quiet (Esc, Ctrl-C). */
  extensionKeys?: { press: (key: string) => boolean; interrupt: () => void };
  /** Extensions' slash commands: in the menu, run by `/name args`. */
  extensionCommands?: ExtensionCommands;
  write: (text: string) => void;
  /** 0-based model id shown in the status line. */
  model: string;
  contextWindow: number;
  /** The thinking level shown on the rule above the editor ("LOW · 2048"). */
  thinking?: string;
  /** The thinking profile in effect at start (THINKING's name), when the config matches one. */
  thinkingProfile?: string;
  /** The engine takes a thinking token budget (Strata's reasoning_budget_tokens): profiles send it. */
  budgets?: boolean;
  /** Switching endpoints and adding models; without it the models page lists the engine's own only. */
  models?: ModelsHost;
  /** Where /extensions and /skills install from; without them their pages say so. */
  extensions?: Catalog;
  skills?: Catalog;
  /** Puts an install or a removal into effect now (loads the extension, tells the model of the
   *  skill); says how. Without it, they take effect when kinoko starts again. */
  apply?: (kind: "extensions" | "skills", name: string, change: Change) => Promise<string>;
  /** The startup panel as it is now (extensions and skills switched on or off since): its
   *  [Capabilities] lines replace the ones printed at the top. */
  capabilities?: () => Promise<string>;
  /** Background jobs (bash background: true): their label on the rule, /jobs and their windows. */
  jobs?: Jobs;
  viewportRows?: number;
  viewportCols?: number;
  /** The line under the editor (cwd and git branch). Re-read after every tool call: tools can
   *  create a repository or switch branch. */
  place?: () => Promise<string>;
  session?: Session;
  /** Called by /quit. The demo and the CLI pass the process exit. */
  onQuit?: () => void;
  /** /sessions' R: that session loaded in place of this one, and the startup panel to print again. */
  resumeSession?: (path: string) => Promise<{ session: Session; intro: string }>;
  /** /new: a new session for a new conversation, and the startup panel to print again. */
  newSession?: () => Promise<{ session: Session; intro: string }>;
  /** Rebuilds the agent after /fork moved the session head. */
  rebuild?: () => Agent;
  /** Lends the terminal to the user's shell (`command`, or an interactive one when empty) and
   *  takes it back once that ends: its exit code. */
  handOver?: (command: string) => Promise<number>;
  /** Reads the clipboard image for Ctrl+V (an Image, or why not). Tests pass a fake. */
  clipboard?: (signal: AbortSignal) => Promise<Image | string>;
  /** Where a pasted relative image path is read from, and git is asked about changes. */
  cwd?: string;
  /** The side panel's changes (git by default). Tests pass a fake. */
  changes?: ChangesSource;
  /** /integrations: where integrations.json lives, Telegram's address and whether kinoko serve
   *  runs (tests pass fakes); unset: the user's home, the real Telegram, the hub's socket. */
  integrations?: Partial<Pick<IntegrationsHost, "home" | "apiBase" | "hubRunning" | "filesExtension">>;
}
