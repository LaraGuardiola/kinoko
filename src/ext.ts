// Extensions: plain .ts files with a default export, loaded from ~/.kinoko/ext and <cwd>/.kinoko/ext.
//
// They only ever get the Kinoko handle below: no imports of core internals, no monkey patching. A
// handler that throws is logged and skipped, because a broken extension must never break a run.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { uniqueDirs } from "./context.ts";
import type { Message, ProviderRequest, Tool } from "./types.ts";
import type { RunResult } from "./loop.ts";

export interface SessionStartInfo {
  cwd: string;
  model: string;
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
  tool_call: (call: ToolCallEvent) => ToolCallBlock | void;
  tool_result: (result: ToolResultEvent) => void;
  turn_end: (message: Message) => void;
  compact: (info: CompactInfo) => void;
  run_end: (result: RunResult) => void;
}

export type ExtEvent = keyof ExtHandlers;
export type CommandHandler = (args: string) => string | Promise<string>;
export type ExtensionFactory = (k: Kinoko) => void | Promise<void>;

export interface Kinoko {
  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void;
  registerTool(tool: Tool): void;
  registerCommand(name: string, handler: CommandHandler): void;
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
  #log: (line: string) => void;

  constructor(log?: (line: string) => void) {
    this.#log = log ?? ((line) => process.stderr.write(`[ext] ${line}\n`));
  }

  on<E extends ExtEvent>(event: E, handler: ExtHandlers[E]): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler as AnyHandler);
    this.#handlers.set(event, list);
  }

  registerTool(tool: Tool): void {
    this.#tools.push(tool);
  }

  registerCommand(name: string, handler: CommandHandler): void {
    this.#commands.set(name, handler);
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

  emit<E extends ExtEvent>(event: E, payload: Parameters<ExtHandlers[E]>[0]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        (handler as (arg: unknown) => unknown)(payload);
      } catch (e) {
        this.log(`${event} handler threw, skipping: ${errText(e)}`);
      }
    }
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

  /** tool_call: args may be mutated in place; the first block wins. */
  beforeTool(call: ToolCallEvent): ToolCallBlock | undefined {
    for (const handler of this.#handlers.get("tool_call") ?? []) {
      try {
        const decision = (handler as (c: ToolCallEvent) => unknown)(call);
        if (isBlock(decision)) return decision;
      } catch (e) {
        this.log(`tool_call handler threw, skipping: ${errText(e)}`);
      }
    }
    return undefined;
  }
}

function isBlock(value: unknown): value is ToolCallBlock {
  return typeof value === "object" && value !== null && (value as ToolCallBlock).block === true;
}

/**
 * User extensions first, then project ones, each directory in name order, so load order (and
 * therefore who wins a command name) is the same on every machine. Imported in parallel, then run
 * in that order.
 */
export async function loadExtensions(k: Extensions, opts: LoadOptions): Promise<string[]> {
  const home = opts.home ?? process.env.HOME ?? "";
  const dirs = uniqueDirs([join(home, ".kinoko", "ext"), join(opts.cwd, ".kinoko", "ext")]);
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of listTs(dir)) paths.push(join(dir, name));
  }
  const mods = await Promise.all(paths.map((path) => importDefault(path, k)));
  const loaded: string[] = [];
  for (const [index, factory] of mods.entries()) {
    const path = paths[index];
    if (factory === null || path === undefined) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- factories run in load order on purpose
      await factory(k);
      loaded.push(path);
    } catch (e) {
      k.log(`failed to start ${path}: ${errText(e)}`);
    }
  }
  return loaded;
}

function listTs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .toSorted()
      .filter((name) => name.endsWith(".ts"));
  } catch {
    return [];
  }
}

async function importDefault(path: string, k: Extensions): Promise<null | ExtensionFactory> {
  try {
    const mod = (await import(path)) as { default?: unknown };
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