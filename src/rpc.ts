// RPC mode: JSONL over stdio, one object per line, in both directions.
//
// Commands in: prompt, steer, follow_up, abort, get_state, get_messages. Events out: the
// AgentEvent stream.
// steer, follow_up and abort work while a run is in progress, because they go straight to the
// Agent. One request at a time: a second prompt while busy is refused, never queued silently.

import type { Agent, RunResult } from "./loop.ts";
import type { AgentEvent } from "./loop.ts";
import type { Image, Message } from "./types.ts";

export interface RpcCommand {
  type: "prompt" | "steer" | "follow_up" | "abort" | "get_state" | "get_messages";
  text?: string;
  images?: Image[]; // prompt, steer, follow_up: pictures that go with the text
  id?: string; // optional, echoed back on the reply
}

export interface RpcReply {
  type: "ok" | "error";
  id?: string;
  text?: string;
  detail?: string;
  state?: RpcState;
  messages?: Message[]; // get_messages: the conversation so far
}

export interface RpcState {
  running: boolean;
  model: string;
  messages: number;
  session?: string;
  cwd?: string;
}

export interface RpcDeps {
  agent: Agent;
  model: string;
  /** The session's id and the working directory, reported in get_state. */
  session?: string;
  cwd?: string;
  /** Where replies and events go. Injectable so tests can read them without stdio. */
  write: (text: string) => void;
  /** Runs when the caller closes stdin. */
  onClose?: () => void;
}

export class Rpc {
  #agent: Agent;
  #model: string;
  #session: string | undefined;
  #cwd: string | undefined;
  #write: (text: string) => void;
  #onClose: (() => void) | undefined;
  #active: Promise<RunResult> | undefined;
  #last: RunResult | undefined;

  constructor(deps: RpcDeps) {
    this.#agent = deps.agent;
    this.#model = deps.model;
    this.#session = deps.session;
    this.#cwd = deps.cwd;
    this.#write = deps.write;
    this.#onClose = deps.onClose;
    this.#agent.on((e) => this.#event(e));
  }

  get running(): boolean {
    return this.#active !== undefined;
  }

  get lastResult(): RunResult | undefined {
    return this.#last;
  }

  /** Handles one raw line. Bad input is answered, never thrown. */
  handle(line: string): void {
    let command: RpcCommand;
    try {
      command = JSON.parse(line) as RpcCommand;
    } catch {
      this.#reply({ type: "error", detail: `not JSON: ${line.slice(0, 80)}` });
      return;
    }
    if (command === null || typeof command !== "object" || typeof command.type !== "string") {
      this.#reply({ type: "error", id: command?.id, detail: 'expected {"type": "...", "text": "..."}' });
      return;
    }
    switch (command.type) {
      case "prompt":
        this.#prompt(command);
        return;
      case "steer":
        this.#steer(command);
        return;
      case "follow_up":
        this.#followUp(command);
        return;
      case "abort":
        this.#agent.abort();
        this.#reply({ type: "ok", id: command.id, text: "aborting" });
        return;
      case "get_state":
        this.#reply({ type: "ok", id: command.id, state: this.#state() });
        return;
      case "get_messages":
        this.#reply({ type: "ok", id: command.id, messages: this.#agent.messages });
        return;
      default:
        this.#reply({ type: "error", id: command.id, detail: `unknown command: ${command.type}` });
        return;
    }
  }

  close(): void {
    this.#onClose?.();
  }

  async #prompt(command: RpcCommand): Promise<void> {
    if (this.running) {
      this.#reply({ type: "error", id: command.id, detail: "a run is in progress: use steer or follow_up" });
      return;
    }
    const text = (command.text ?? "").trim();
    if (text === "") {
      this.#reply({ type: "error", id: command.id, detail: "prompt needs text" });
      return;
    }
    this.#active = this.#agent.prompt(text, images(command));
    this.#reply({ type: "ok", id: command.id, text: "started" });
    const result = await this.#active;
    this.#active = undefined;
    this.#last = result;
    this.#reply({ type: "ok", id: command.id, text: result.reason, state: this.#state() });
  }

  #steer(command: RpcCommand): void {
    const text = (command.text ?? "").trim();
    if (text === "") {
      this.#reply({ type: "error", id: command.id, detail: "steer needs text" });
      return;
    }
    if (!this.running) {
      this.#reply({ type: "error", id: command.id, detail: "no run in progress" });
      return;
    }
    this.#agent.steer(text, images(command));
    this.#reply({ type: "ok", id: command.id, text: "steering" });
  }

  #followUp(command: RpcCommand): void {
    const text = (command.text ?? "").trim();
    if (text === "") {
      this.#reply({ type: "error", id: command.id, detail: "follow_up needs text" });
      return;
    }
    if (!this.running) {
      this.#reply({ type: "error", id: command.id, detail: "no run in progress" });
      return;
    }
    this.#agent.followUp(text, images(command));
    this.#reply({ type: "ok", id: command.id, text: "follow up queued" });
  }

  #state(): RpcState {
    return {
      running: this.running,
      model: this.#model,
      messages: this.#agent.messages.length,
      ...(this.#session ? { session: this.#session } : {}),
      ...(this.#cwd ? { cwd: this.#cwd } : {}),
    };
  }

  #event(event: AgentEvent): void {
    // One line per event, exactly as it came: a client renders these itself.
    this.#write(`${JSON.stringify({ type: "event", event: event })}\n`);
  }

  #reply(reply: RpcReply): void {
    this.#write(`${JSON.stringify(reply)}\n`);
  }
}

/** A command's images, only well-formed ones. */
function images(command: RpcCommand): Image[] | undefined {
  const list = Array.isArray(command.images) ? command.images.filter((i) => typeof i?.mime === "string" && typeof i.data === "string") : [];
  return list.length > 0 ? list : undefined;
}

/** Wires stdin to an Rpc. Returns a function that detaches the listeners. */
export function serveStdio(rpc: Rpc): () => void {
  let buffer = "";
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") rpc.handle(line);
      at = buffer.indexOf("\n");
    }
  };
  const onEnd = (): void => {
    rpc.close();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
  };
}

/** Last-resort filter so a client is not flooded by partial JSON. */
export function isCompleteLine(buffer: string): boolean {
  return buffer.endsWith("\n") && buffer.trim() !== "";
}

/** Messages as plain text, for a client that wants to render its own transcript. */
export function describe(messages: Message[]): string {
  return messages
    .map((m) => `${m.role}: ${m.content}${m.toolCalls ? ` [${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}`)
    .join("\n");
}