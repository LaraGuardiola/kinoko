// Extensions: a .ts file, or a folder with an index.ts (and its own node_modules, when it has
// dependencies), with a default export, loaded from ~/.kinoko/ext and <cwd>/.kinoko/ext.
//
// They only ever get the Kinoko handle below: no imports of core internals, no monkey patching. A
// handler that throws is logged and skipped, because a broken extension must never break a run.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniqueDirs } from "./context.ts";
import { readDisabled } from "./disabled.ts";
import type { Message, ProviderRequest, Tool } from "./types.ts";
import type { RunResult } from "./agent-events.ts";
import { userHome } from "./home.ts";
import { extensionPlatforms, runsHere } from "./platforms.ts";

export interface SessionStartInfo {
  cwd: string;
  model: string;
  mode: "tui" | "print" | "rpc";
}

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>; // mutate in place to change what the tool receives
  signal: AbortSignal;
}

export interface ToolCallBlock {
  block: true;
  reason: string; // becomes the tool result the model sees
}

/** Asks the user before the call runs (the loop waits for the answer); a deny is the tool's result. */
export interface ToolCallAsk {
  ask: true;
  reason: string; // shown to the user with the call
}

export type ToolCallDecision = ToolCallBlock | ToolCallAsk;

export interface ToolResultEvent {
  name: string;
  output: string; // mutate in place to rewrite what the model sees
  signal: AbortSignal;
}

export interface CompactInfo {
  before: number;
  after: number;
}

export interface ExtHandlers {
  session_start: (info: SessionStartInfo) => void;
  context: (messages: Message[]) => Message[]; // rewrite the history before a provider call
  before_provider_request: (req: ProviderRequest) => void;
  tool_call: (call: ToolCallEvent) => ToolCallDecision | void;
  tool_result: (result: ToolResultEvent) => void;
  turn_end: (message: Message) => void;
  compact: (info: CompactInfo) => void;
  run_end: (result: RunResult) => void;
}

export type ExtEvent = keyof ExtHandlers;
export type CommandHandler = (args: string) => string | Promise<string>;
/** Draws a fenced block of its language (```mermaid) in the transcript: the rows, each at most
 *  `width` columns, or undefined to show the source as code. Called with whole blocks only. */
export type FenceRenderer = (source: string, width: number) => string[] | undefined;
export type ExtensionFactory = (k: Kinoko) => void | Promise<void>;

export interface Kinoko {
  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void;
  registerTool(tool: Tool): void;
  /** `/name args` in the TUI (listed in its slash menu with `description`), and `kinoko /name args`. */
  registerCommand(name: string, handler: CommandHandler, description?: string): void;
  registerRenderer(lang: string, render: FenceRenderer): void;
  log(message: string): void;
}

export interface LoadOptions {
  cwd: string;
  home?: string;
}

type AnyHandler = (arg: never) => unknown;

function errText(e: unknown): string {
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

export class Extensions implements Kinoko {
  #handlers = new Map<ExtEvent, AnyHandler[]>();
  #tools: Tool[] = [];
  #commands = new Map<string, CommandHandler>();
  #renderers = new Map<string, FenceRenderer>();
  #described = new WeakMap<CommandHandler, string>();
  #log: (line: string) => void;
  // Who registered what, so one extension can be taken back (unload) while kinoko runs.
  #owner = "";
  #ownerOf = new Map<unknown, string>();
  #session: SessionStartInfo | undefined; // replayed to an extension that starts later

  constructor(log?: (line: string) => void) {
    this.#log = log ?? ((line) => process.stderr.write(`[ext] ${line}\n`));
  }

  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler as AnyHandler);
    this.#handlers.set(event, list);
    this.#ownerOf.set(handler, this.#owner);
  }

  registerTool(tool: Tool): void {
    this.#tools.push(tool);
    this.#ownerOf.set(tool, this.#owner);
  }

  registerCommand(name: string, handler: CommandHandler, description?: string): void {
    this.#commands.set(name, handler);
    if (description) this.#described.set(handler, description);
    this.#ownerOf.set(handler, this.#owner);
  }

  registerRenderer(lang: string, render: FenceRenderer): void {
    this.#renderers.set(lang.toLowerCase(), render);
    this.#ownerOf.set(render, this.#owner);
  }

  /** The renderer for a fence's language, if an extension draws it. */
  renderer(lang: string): FenceRenderer | undefined {
    return this.#renderers.get(lang.toLowerCase());
  }

  /** Runs an extension's factory as `name`: what it registers is its own. A session already
   *  started is replayed to it, so it starts like the others did. */
  async start(name: string, factory: ExtensionFactory): Promise<void> {
    this.#owner = name;
    try {
      await factory(this);
    } finally {
      this.#owner = "";
    }
    const info = this.#session;
    if (info === undefined) return;
    for (const handler of this.#handlers.get("session_start") ?? []) {
      if (this.#ownerOf.get(handler) === name) this.#call("session_start", handler, info);
    }
  }

  /** One handler call; what it registers belongs to its extension, and a throw is logged. */
  #call(event: ExtEvent, handler: AnyHandler, payload: unknown): unknown {
    this.#owner = this.#ownerOf.get(handler) ?? "";
    try {
      return (handler as (arg: unknown) => unknown)(payload);
    } catch (e) {
      this.log(`${event} handler threw, skipping: ${errText(e)}`);
      return undefined;
    } finally {
      this.#owner = "";
    }
  }

  /** Takes back everything `name` registered (handlers, tools, commands, renderers); false when it had nothing.
   *  What it already did outside kinoko (a timer, a socket) is its own business. */
  unload(name: string): boolean {
    const mine = (item: unknown): boolean => this.#ownerOf.get(item) === name;
    let found = false;
    for (const [event, list] of this.#handlers) {
      const kept = list.filter((h) => !mine(h));
      found ||= kept.length !== list.length;
      this.#handlers.set(event, kept);
    }
    const tools = this.#tools.filter((t) => !mine(t));
    found ||= tools.length !== this.#tools.length;
    this.#tools = tools;
    for (const map of [this.#commands, this.#renderers] as Map<string, unknown>[]) {
      for (const [key, item] of map) {
        if (!mine(item)) continue;
        map.delete(key);
        found = true;
      }
    }
    for (const [item, owner] of this.#ownerOf) if (owner === name) this.#ownerOf.delete(item);
    return found;
  }

  log(message: string): void {
    this.#log(message);
  }

  /** Tools contributed by extensions, callable by the agent like any other. */
  tools(): Tool[] {
    return [...this.#tools];
  }

  command(name: string): CommandHandler | undefined {
    return this.#commands.get(name);
  }

  commandNames(): string[] {
    return [...this.#commands.keys()].toSorted();
  }

  /** The commands extensions add, with what each says it does: the TUI's slash menu lists them. */
  commandList(): Array<{ name: string; description: string }> {
    return this.commandNames().map((name) => {
      const handler = this.#commands.get(name);
      return { name, description: (handler && this.#described.get(handler)) ?? "an extension's command" };
    });
  }

  emit<E extends ExtEvent>(event: E, payload: Parameters<ExtHandlers[E]>[0]): void {
    if (event === "session_start") this.#session = payload as SessionStartInfo;
    for (const handler of this.#handlers.get(event) ?? []) this.#call(event, handler, payload);
  }

  /** Chained event: each handler sees what the previous one returned. */
  chain(event: "context", messages: Message[]): Message[] {
    let current = messages;
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        const next = (handler as (m: Message[]) => unknown)(current);
        if (Array.isArray(next)) {
          current = next as Message[];
        } else {
          this.log("context handler did not return messages, keeping the previous ones");
        }
      } catch (e) {
        this.log(`${event} handler threw, skipping: ${errText(e)}`);
      }
    }
    return current;
  }

  /** tool_call: args may be mutated in place; the first block wins, even over an earlier ask. */
  beforeTool(call: ToolCallEvent): (ToolCallDecision & { by: string }) | undefined {
    let ask: (ToolCallAsk & { by: string }) | undefined;
    for (const handler of this.#handlers.get("tool_call") ?? []) {
      try {
        const decision = (handler as (c: ToolCallEvent) => unknown)(call);
        const by = this.#ownerOf.get(handler) ?? "";
        if (isBlock(decision)) return { ...decision, by };
        if (ask === undefined && isAsk(decision)) ask = { ...decision, by };
      } catch (e) {
        this.log(`tool_call handler threw, skipping: ${errText(e)}`);
      }
    }
    return ask;
  }
}

function isBlock(value: unknown): value is ToolCallBlock {
  return typeof value === "object" && value !== null && (value as ToolCallBlock).block === true;
}

function isAsk(value: unknown): value is ToolCallAsk {
  return typeof value === "object" && value !== null && (value as ToolCallAsk).ask === true && typeof (value as ToolCallAsk).reason === "string";
}

/**
 * User extensions first, then project ones, each directory in name order, so load order (and
 * therefore who wins a command name) is the same on every machine. Imported in parallel, then run
 * in that order.
 */
export async function loadExtensions(k: Extensions, opts: LoadOptions): Promise<string[]> {
  const home = opts.home ?? userHome();
  const dirs = uniqueDirs([join(home, ".kinoko", "ext"), join(opts.cwd, ".kinoko", "ext")]);
  const off = new Set((await readDisabled(home)).extensions); // switched off in /extensions
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of listEntries(dir)) if (!off.has(extensionName(join(dir, name)))) paths.push(join(dir, name));
  }
  // Another system's (package.json "os"): not loaded, so none of its tools reach the model.
  const here = await Promise.all(paths.map(async (path) => runsHere(await extensionPlatforms(dirname(path)))));
  for (const [i, path] of paths.entries()) if (!here[i]) k.log(`${extensionName(path)} is not for this system: not loaded`);
  const mods = await Promise.all(paths.map((path, i) => (here[i] ? importDefault(path, k) : null)));
  const loaded: string[] = [];
  for (const [index, factory] of mods.entries()) {
    const path = paths[index];
    if (factory === null || path === undefined) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- factories run in load order on purpose
      await k.start(extensionName(path), factory);
      loaded.push(path);
    } catch (e) {
      k.log(`failed to start ${path}: ${errText(e)}`);
    }
  }
  return loaded;
}

/** `name.ts` files and `name/index.ts` folders, in name order. */
function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) // the same order on every machine
      .flatMap((e) => (e.isFile() && e.name.endsWith(".ts") ? [e.name] : e.isDirectory() && existsSync(join(dir, e.name, "index.ts")) ? [join(e.name, "index.ts")] : []));
  } catch {
    return [];
  }
}

/** What an extension is called: its file without `.ts`, or its folder. */
export function extensionName(path: string): string {
  const parts = path.split(/[\\/]/); // either separator: Windows paths too
  const file = parts.at(-1) ?? path;
  return (file === "index.ts" ? (parts.at(-2) ?? file) : file).replace(/\.ts$/, "");
}

let reloads = 0;

/**
 * (Re)loads one extension while kinoko runs: imported afresh (an updated file is read again), then
 * the old copy's registrations are taken back and the new one starts. An extension that fails to
 * import leaves the old copy running. Returns why it did not load, or undefined.
 */
export async function loadOne(k: Extensions, path: string): Promise<string | undefined> {
  const factory = await importDefault(path, k, `${path}?v=${Date.now()}-${++reloads}`); // a new module, not the cached one
  if (factory === null) return `${extensionName(path)} did not load (see the log)`;
  const name = extensionName(path);
  k.unload(name);
  try {
    await k.start(name, factory);
    return undefined;
  } catch (e) {
    k.unload(name);
    return `${name} did not start: ${errText(e)}`;
  }
}

async function importDefault(path: string, k: Extensions, specifier = path): Promise<null | ExtensionFactory> {
  try {
    const mod = (await import(specifier)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      k.log(`${path} has no default export, skipping`);
      return null;
    }
    return mod.default as ExtensionFactory;
  } catch (e) {
    k.log(`failed to load ${path}: ${errText(e)}`);
    return null;
  }
}