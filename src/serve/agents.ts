// The agents `kinoko serve` runs: one `kinoko --mode rpc` child per agent, in its project's
// directory, so each has its own context, extensions, session and tools (they use the process's
// cwd). The hub relays commands in and events out, keeps each agent's state for the list, and the
// events of the run in progress, so a phone that attaches mid-run sees it from its start.

import { basename } from "node:path";
import type { AgentEvent } from "../loop.ts";
import type { RpcCommand, RpcReply, RpcState } from "../rpc.ts";
import type { Message } from "../types.ts";

export interface AgentInfo {
  id: string;
  cwd: string;
  project: string;
  model: string;
  state: "starting" | "idle" | "running" | "exited";
  session?: string;
  /** The first prompt of the conversation, as a name for it. */
  title?: string;
  started: number;
  /** Last time something happened (an event, a prompt). */
  activity: number;
  /** Why it exited, from its last stderr lines. */
  error?: string;
}

export interface Child {
  write: (line: string) => void;
  lines: AsyncIterable<string>;
  errors: AsyncIterable<string>;
  exited: Promise<number>;
  kill: () => void;
}

export type Spawn = (cmd: string[], cwd: string) => Child;

async function* lines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  }
  if (buffer !== "") yield buffer;
}

export const spawnChild: Spawn = (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    write: (line) => {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    },
    lines: lines(proc.stdout),
    errors: lines(proc.stderr),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

/** Events kept per agent for a late attach: the run in progress, never more than this. */
const LIVE_MAX = 4000;

interface Running {
  info: AgentInfo;
  child: Child;
  live: AgentEvent[];
  waiting: Map<string, (reply: RpcReply) => void>;
  stderr: string[];
}

export interface StartOptions {
  cwd: string;
  /** A session id to resume, or "continue" for the project's latest. */
  session?: string;
  model?: string;
}

export class Agents {
  #command: string[];
  #spawn: Spawn;
  #onChange: () => void;
  #onEvent: (id: string, event: AgentEvent) => void;
  #agents = new Map<string, Running>();
  #seq = 0;

  constructor(opts: { command: string[]; spawn?: Spawn; onChange: () => void; onEvent: (id: string, event: AgentEvent) => void }) {
    this.#command = opts.command;
    this.#spawn = opts.spawn ?? spawnChild;
    this.#onChange = opts.onChange;
    this.#onEvent = opts.onEvent;
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()].map((a) => Object.assign({}, a.info)).toSorted((a, b) => b.activity - a.activity);
  }

  info(id: string): AgentInfo | undefined {
    const a = this.#agents.get(id);
    return a ? { ...a.info } : undefined;
  }

  start(opts: StartOptions): AgentInfo {
    const id = crypto.randomUUID().slice(0, 8);
    const resume = opts.session === "continue" ? ["--continue"] : opts.session ? ["--session", opts.session] : [];
    const child = this.#spawn([...this.#command, "--mode", "rpc", ...resume, ...(opts.model ? ["--model", opts.model] : [])], opts.cwd);
    const now = Date.now();
    const agent: Running = {
      info: { id, cwd: opts.cwd, project: basename(opts.cwd), model: opts.model ?? "", state: "starting", started: now, activity: now },
      child,
      live: [],
      waiting: new Map(),
      stderr: [],
    };
    this.#agents.set(id, agent);
    void this.#read(agent);
    void (async () => {
      for await (const line of child.errors) agent.stderr = [...agent.stderr.slice(-9), line];
    })();
    void child.exited.then((code) => {
      agent.info.state = "exited";
      if (code !== 0) agent.info.error = agent.stderr.filter((l) => !l.startsWith("[ext] loaded")).slice(-3).join("\n") || `exit code ${code}`;
      for (const resolve of agent.waiting.values()) resolve({ type: "error", detail: "the agent exited" });
      agent.waiting.clear();
      this.#onChange();
    });
    // Its model and session, from the agent itself.
    void this.send(id, { type: "get_state" }).then((reply) => {
      if (reply.state) this.#state(agent, reply.state);
      if (agent.info.state === "starting") agent.info.state = reply.state?.running ? "running" : "idle";
      this.#onChange();
    });
    this.#onChange();
    return { ...agent.info };
  }

  #state(agent: Running, state: RpcState): void {
    agent.info.model = state.model || agent.info.model;
    if (state.session) agent.info.session = state.session;
  }

  async #read(agent: Running): Promise<void> {
    for await (const line of agent.child.lines) {
      let msg: Omit<RpcReply, "type"> & { type?: string; event?: AgentEvent };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // not ours (a stray print)
      }
      if (msg.type === "event" && msg.event) this.#event(agent, msg.event);
      else if (msg.id !== undefined && agent.waiting.has(msg.id)) {
        agent.waiting.get(msg.id)?.(msg as RpcReply);
        agent.waiting.delete(msg.id);
      }
    }
  }

  #event(agent: Running, event: AgentEvent): void {
    const info = agent.info;
    info.activity = Date.now();
    if (event.type === "run_start") {
      agent.live = [];
      info.state = "running";
      info.title ??= event.prompt.split("\n")[0]?.slice(0, 80);
    }
    agent.live.push(event);
    if (agent.live.length > LIVE_MAX) agent.live.splice(0, agent.live.length - LIVE_MAX);
    if (event.type === "run_end") info.state = "idle";
    this.#onEvent(info.id, event);
    if (event.type === "run_start" || event.type === "run_end") this.#onChange();
  }

  /** One command to an agent; resolves with its first reply. */
  send(id: string, command: RpcCommand): Promise<RpcReply> {
    const agent = this.#agents.get(id);
    if (agent === undefined) return Promise.resolve({ type: "error", detail: `no agent ${id}` });
    if (agent.info.state === "exited") return Promise.resolve({ type: "error", detail: "the agent exited" });
    const tag = `h${++this.#seq}`;
    return new Promise((resolve) => {
      agent.waiting.set(tag, resolve);
      agent.child.write(JSON.stringify({ ...command, id: tag }));
    });
  }

  /** The conversation so far and the run in progress, for a client that attaches. */
  async snapshot(id: string): Promise<{ messages: Message[]; live: AgentEvent[] } | undefined> {
    const agent = this.#agents.get(id);
    if (agent === undefined) return undefined;
    const reply = await this.send(id, { type: "get_messages" });
    // Events of the run in progress that are not in the messages yet: those after the last
    // message_end (a message_end's message is already in the history).
    const lastEnd = agent.live.findLastIndex((e) => e.type === "message_end" || e.type === "tool_end");
    const live = agent.info.state === "running" ? agent.live.slice(lastEnd + 1) : [];
    return { messages: reply.messages ?? [], live };
  }

  stop(id: string): boolean {
    const agent = this.#agents.get(id);
    if (agent === undefined) return false;
    agent.child.kill();
    this.#agents.delete(id);
    this.#onChange();
    return true;
  }

  stopAll(): void {
    for (const id of this.#agents.keys()) this.stop(id);
  }
}
