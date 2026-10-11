// Slash commands for a client without the TUI's menu: the phone app, through kinoko serve and the
// rpc mode. The same things the menu does, as answers: a list of items with their state to act
// on (thinking profiles, extensions, skills), or a note on what was done (new, compact). A TUI
// linked to the hub answers them through itself, so its screen follows what the phone changed.

import type { Catalog, Change, Entry } from "./catalog.ts";
import type { Agent } from "./loop.ts";
import { THINKING } from "./tui/menu-pages.ts";
import { applyProfile, currentProfile, readProfiles } from "./profiles.ts";

export interface CommandInfo {
  name: string;
  description: string;
  /** "list": answers with items to act on; "run": does it at once and says so. */
  kind: "list" | "run";
}

export interface CommandItem {
  name: string;
  description: string;
  /** In effect: the thinking profile in use, an extension switched on. */
  current?: boolean;
  /** Installed but switched off. */
  off?: boolean;
  installed?: boolean;
  /** A skill other agents share (~/.agents/skills): switched on or off here, never removed. */
  shared?: boolean;
}

export interface CommandResult {
  title?: string;
  /** What was done, or what there is to read (session). */
  text?: string;
  items?: CommandItem[];
  /** Under the list: why it is the local copy (offline), what the actions are. */
  hint?: string;
  /** The conversation was replaced (new): the client fetches it again. */
  reset?: boolean;
  /** The view is to be wiped (clear): the conversation stays. */
  clear?: boolean;
}

export interface CommandHost {
  agent: Agent;
  catalogs?: { extensions?: Catalog; skills?: Catalog };
  apply?: (kind: "extensions" | "skills", name: string, change: Change) => Promise<string>;
  newSession?: () => Promise<void>;
  thinking?: { current: () => string | undefined; set: (name: string) => string };
  /** The models to switch to (the current one marked); the agent's provider's when not given. */
  models?: { list: (signal: AbortSignal) => Promise<CommandItem[]>; set: (name: string) => string };
  /** /clear: the TUI's screen; a client wipes its own view either way. */
  clear?: () => void;
  /** /fork: the session's head back one message (a TUI's). */
  fork?: () => Promise<string>;
  session?: () => string;
  /** Something the phone changed, for the terminal to show. */
  told?: (note: string) => void;
}

export function commandList(host: CommandHost): CommandInfo[] {
  const all: Array<CommandInfo | false> = [
    host.newSession !== undefined && { name: "new", description: "Start a new session: empty context, same model", kind: "run" },
    { name: "compact", description: "Summarize the history now", kind: "run" },
    host.thinking !== undefined && { name: "thinking", description: "How much the model thinks", kind: "list" },
    { name: "models", description: "Pick the model for the next requests", kind: "list" },
    host.catalogs?.extensions !== undefined && { name: "extensions", description: "Switch extensions on or off, install, update, remove", kind: "list" },
    host.catalogs?.skills !== undefined && { name: "skills", description: "Switch skills on or off, install, update, remove", kind: "list" },
    host.catalogs !== undefined && { name: "profile", description: "Switch profile: what is on, how much it thinks, what it asks", kind: "list" },
    host.session !== undefined && { name: "session", description: "This session: id, messages, tokens", kind: "run" },
    { name: "clear", description: "Clear the view (the context stays)", kind: "run" },
    host.fork !== undefined && { name: "fork", description: "Move the session head back one message", kind: "run" },
    { name: "help", description: "The commands", kind: "run" },
  ];
  return all.filter((c) => c !== false);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runCommand(host: CommandHost, name: string, arg: string, signal: AbortSignal): Promise<CommandResult> {
  switch (name) {
    case "new":
      if (host.newSession === undefined) break;
      await host.newSession();
      host.told?.("new session, from the phone");
      return { text: "new session: the model starts with no history", reset: true };
    case "compact": {
      const done = await host.agent.compactNow();
      return { text: done ? "compacted: the history is a summary now" : "nothing to compact yet" };
    }
    case "thinking": {
      if (host.thinking === undefined) break;
      const note = arg.trim() === "" ? undefined : host.thinking.set(arg.trim());
      if (note !== undefined) host.told?.(note);
      const current = host.thinking.current();
      return { title: "Thinking", text: note, items: THINKING.map((p) => ({ name: p.name, description: p.description, current: p.name === current })) };
    }
    case "extensions":
    case "skills":
      if (host.catalogs?.[name] === undefined) break;
      return catalogCommand(host, name, arg, signal);
    case "profile": {
      if (host.catalogs === undefined) break;
      const home = process.env.HOME ?? "";
      const all = await readProfiles(home);
      const chosen = arg.trim() === "" ? undefined : all.find((p) => p.name === arg.trim() || p.title.toLowerCase() === arg.trim().toLowerCase());
      if (arg.trim() !== "" && chosen === undefined) return { text: `no profile ${arg.trim()}` };
      const note = chosen ? await applyProfile(host, home, chosen, AbortSignal.any([signal, AbortSignal.timeout(300_000)])) : undefined;
      if (note !== undefined) host.told?.(`profile ${note}`);
      const current = await currentProfile(home);
      return { title: "Profiles", text: note, items: all.map((p) => ({ name: p.name, description: `${p.title} · ${p.description}`, current: p.name === current })) };
    }
    case "session":
      if (host.session === undefined) break;
      return { title: "Session", text: host.session() };
    case "models":
      return modelsCommand(host, arg.trim(), signal);
    case "clear":
      host.clear?.();
      return { text: "cleared: the context stays", clear: true };
    case "fork":
      if (host.fork === undefined) break;
      return { text: await host.fork(), reset: true };
    case "help":
      return { title: "Commands", text: commandList(host).map((c) => `/${c.name}  ${c.description}`).join("\n") };
    default:
      break;
  }
  return { text: `no command /${name} here` };
}

/** The models to pick from, the current one marked; with a name, a switch to it. */
async function modelsCommand(host: CommandHost, name: string, signal: AbortSignal): Promise<CommandResult> {
  let text: string | undefined;
  if (name !== "") {
    if (host.models) text = host.models.set(name);
    else {
      host.agent.setModel(name);
      text = `model: ${name.split("/").at(-1)} from the next request`;
    }
    host.told?.(`${text} (from the phone)`);
  }
  const timed = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const items = host.models
    ? await host.models.list(timed)
    : (await host.agent.models(timed).catch(() => [] as string[])).map((m) => ({ name: m, description: "", current: m === host.agent.model }));
  // The model in use is always there to go back to, served or not.
  if (!items.some((i) => i.name === host.agent.model)) items.unshift({ name: host.agent.model, description: "in use", current: true });
  for (const item of items) item.current = item.name === host.agent.model;
  return { title: "Models", text, items };
}

/** A catalog's list, or one change to it ("on web", "off web", "install web", "update web", "remove web"). */
async function catalogCommand(host: CommandHost, kind: "extensions" | "skills", arg: string, signal: AbortSignal): Promise<CommandResult> {
  const store = host.catalogs?.[kind] as Catalog;
  const title = kind === "skills" ? "Skills" : "Extensions";
  const action = /^(on|off|install|update|remove)\s+(\S+)$/.exec(arg.trim());
  let note: string | undefined;
  if (action) {
    const [, verb = "", entry = ""] = action;
    const change: Change = verb === "on" ? "enable" : verb === "off" ? "disable" : verb === "remove" ? "remove" : "install";
    const done = verb === "on" || verb === "off" ? await store.enable(entry, verb === "on") : verb === "remove" ? await store.remove(entry) : await store.install(entry, AbortSignal.any([signal, AbortSignal.timeout(300_000)]));
    const applied = done.ok && host.apply ? await host.apply(kind, entry, change).catch((e: unknown) => `not applied: ${errorText(e)}`) : undefined;
    note = applied ? `${done.note}: ${applied}` : done.note;
    host.told?.(`${note} (from the phone)`);
  }
  // After a change, what is on disk is enough; a plain listing fetches the repository first.
  let hint = "tap to switch on or off, or to install · hold for update or remove";
  let entries: Entry[];
  if (action) entries = await store.local();
  else {
    entries = await store.list(AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(async (e: unknown) => {
      hint = `${errorText(e)} · showing what is on this computer`;
      return store.local();
    });
  }
  const items = entries.map((e) => ({
    name: e.name,
    description: e.description,
    installed: e.installed,
    current: e.installed && e.enabled !== false,
    off: e.installed && e.enabled === false,
    shared: e.shared === true,
  }));
  return { title, text: note, items, hint };
}
