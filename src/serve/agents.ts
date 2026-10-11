// The agents `kinoko serve` knows: one `kinoko --mode rpc` child per agent it starts, in its
// project's directory, so each has its own context, extensions, session and tools (they use the
// process's cwd); and the TUIs that link themselves to it (origin "terminal", link.ts), which speak
// the same rpc over a socket. The hub relays commands in and events out, keeps each agent's state
// for the list, and the events of the run in progress, so a phone that attaches mid-run sees it
// from its start.

import { basename } from "node:path";
import type { AgentEvent } from "../loop.ts";
import type { RpcCommand, RpcReply, RpcState } from "../rpc.ts";
import type { Message } from "../types.ts";

export interface AgentInfo {
  id: string;
  /** "app": started by the hub; "terminal": a kinoko TUI that linked itself. */
  origin: "app" | "terminal";
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
  /** How its last run ended (for the phone's notification); cleared when a run starts. */
  ended?: "done" | "aborted" | "error" | "limit";
  /** The start of its last reply, one line: what a notification says. */
  last?: string;
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

/** Lines pushed in, read out as an async iterable: a socket's lines, for a linked TUI. */
export function lineQueue(): { push: (line: string) => void; end: () => void; lines: AsyncIterable<string> } {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push: (line) => {
      queue.push(line);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift() ?? "";
          if (done) return;
          // oxlint-disable-next-line no-await-in-loop -- a stream waits for its next line
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
  };
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

/** A reply as one short line: code and markup out, at most 160 characters. */
export function gist(text: string): string {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`;
}

/** Events kept per agent for a late attach: the run in progress, never more than this. */
const LIVE_MAX = 4000;

interface Running {
  info: AgentInfo;
  child: Child;
  live: AgentEvent[];
  waiting: Map<string, (reply: RpcReply) => void>;
  stderr: string[];
}

/** What a linking TUI says first. */
export interface Hello {
  cwd: string;
  model?: string;
  session?: string;
  pid?: number;
  running?: boolean;
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
    return this.#adopt(child, { id, origin: "app", cwd: opts.cwd, project: basename(opts.cwd), model: opts.model ?? "", state: "starting", started: now, activity: now });
  }

  /** A TUI that linked itself over the socket: listed while it stays connected. */
  link(child: Child, hello: Hello): AgentInfo {
    const now = Date.now();
    const id = crypto.randomUUID().slice(0, 8);
    const info: AgentInfo = { id, origin: "terminal", cwd: hello.cwd, project: basename(hello.cwd), model: hello.model ?? "", session: hello.session, state: hello.running ? "running" : "idle", started: now, activity: now };
    const adopted = this.#adopt(child, info);
    // Its conversation started before the link: the first thing said in it names it.
    void this.send(id, { type: "get_messages" }).then((reply) => {
      const first = reply.messages?.find((m) => m.role === "user" && !m.content.startsWith("[kinoko]"))?.content.split("\n")[0];
      const agent = this.#agents.get(id);
      if (agent && first) {
        agent.info.title ??= first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
        this.#onChange();
      }
    });
    return adopted;
  }

  #adopt(child: Child, info: AgentInfo): AgentInfo {
    const id = info.id;
    const agent: Running = { info, child, live: [], waiting: new Map(), stderr: [] };
    this.#agents.set(id, agent);
    void this.#read(agent);
    void (async () => {
      for await (const line of child.errors) agent.stderr = [...agent.stderr.slice(-9), line];
    })();
    void child.exited.then((code) => {
      for (const resolve of agent.waiting.values()) resolve({ type: "error", detail: "the agent is gone" });
      agent.waiting.clear();
      // A terminal that closed (or quit) leaves the list; a child that exited stays, with why.
      if (agent.info.origin === "terminal") {
        if (this.#agents.get(id) === agent) this.#agents.delete(id);
        this.#onChange();
        return;
      }
      agent.info.state = "exited";
      if (code !== 0) agent.info.error = agent.stderr.filter((l) => !l.startsWith("[ext] loaded")).slice(-3).join("\n") || `exit code ${code}`;
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
      info.ended = undefined;
      const first = event.prompt.split("\n")[0] ?? "";
      info.title ??= first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
    }
    agent.live.push(event);
    if (agent.live.length > LIVE_MAX) agent.live.splice(0, agent.live.length - LIVE_MAX);
    if (event.type === "run_end") {
      info.state = "idle";
      info.ended = event.reason;
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.content.trim() !== "") info.last = gist(event.message.content);
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

  /** Ends an agent the hub started. A terminal's is not the phone's to end: it is stopped there. */
  stop(id: string): "stopped" | "missing" | "terminal" {
    const agent = this.#agents.get(id);
    if (agent === undefined) return "missing";
    if (agent.info.origin === "terminal") return "terminal";
    agent.child.kill();
    this.#agents.delete(id);
    this.#onChange();
    return "stopped";
  }

  /** On the hub's way down: its children end, its terminals are let go (they keep working). */
  stopAll(): void {
    for (const [id, agent] of this.#agents) {
      if (agent.info.origin === "terminal") agent.child.kill();
      else this.stop(id);
    }
    this.#agents.clear();
  }
}
