// `kinoko serve`'s HTTP and WebSocket server, on localhost (Tailscale brings the phone in). The
// protocol is in docs/protocol.md: pairing over HTTP, then one WebSocket per device carrying JSON
// messages both ways: the agent list, agents started, attached to, prompted, aborted, stopped.

import { stat } from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import type { AgentEvent } from "../loop.ts";
import type { Image, Message } from "../types.ts";
import { Agents } from "./agents.ts";
import type { Spawn } from "./agents.ts";
import type { Device, Devices } from "./devices.ts";
import { projects } from "./projects.ts";

export const PROTOCOL = 1;

interface Socket {
  device: Device;
  attached: Set<string>;
}

export interface ServeOptions {
  port: number;
  devices: Devices;
  /** How to run kinoko (the binary, or bun and main.ts). */
  command: string[];
  sessionsDir: string;
  version: string;
  host?: string;
  spawn?: Spawn;
  log?: (line: string) => void;
}

/** A message as the app gets it: images as their type and size, not their bytes. */
function light(m: Message): Message & { images?: Array<Image & { size?: number }> } {
  return m.images ? { ...m, images: m.images.map((i) => ({ mime: i.mime, data: "", size: Math.round(i.data.length * 0.75) })) } : m;
}

type Incoming = {
  id?: string;
  type?: string;
  agent?: string;
  cwd?: string;
  session?: string;
  model?: string;
  text?: string;
  images?: Image[];
};

export function serve(opts: ServeOptions): { server: Server<Socket>; agents: Agents; stop: () => void } {
  const sockets = new Set<ServerWebSocket<Socket>>();
  const log = opts.log ?? (() => undefined);
  const send = (ws: ServerWebSocket<Socket>, msg: object): void => void ws.send(JSON.stringify(msg));
  const broadcast = (msg: object): void => {
    for (const ws of sockets) send(ws, msg);
  };

  const agents: Agents = new Agents({
    command: opts.command,
    spawn: opts.spawn,
    onChange: () => broadcast({ type: "agents", agents: agents.list() }),
    onEvent: (id: string, event: AgentEvent) => {
      const msg = JSON.stringify({ type: "event", agent: id, event: event.type === "message_end" ? { ...event, message: light(event.message) } : event });
      for (const ws of sockets) if (ws.data.attached.has(id)) ws.send(msg);
    },
  });

  // A burst of wrong pairing codes (Funnel puts the server on the internet) is slowed down.
  let failures: number[] = [];

  async function handle(ws: ServerWebSocket<Socket>, msg: Incoming): Promise<void> {
    const ok = (extra: object = {}): void => send(ws, { type: "ok", id: msg.id, ...extra });
    const fail = (detail: string): void => send(ws, { type: "error", id: msg.id, detail });
    const agent = msg.agent ?? "";
    switch (msg.type) {
      case "list":
        return send(ws, { type: "agents", id: msg.id, agents: agents.list() });
      case "projects":
        return send(ws, { type: "projects", id: msg.id, projects: await projects(opts.sessionsDir) });
      case "start": {
        if (typeof msg.cwd !== "string" || !(await isDir(msg.cwd))) return fail(`no directory ${String(msg.cwd)}`);
        const info = agents.start({ cwd: msg.cwd, session: msg.session, model: msg.model });
        ws.data.attached.add(info.id);
        log(`${ws.data.device.name} started ${info.id} in ${info.cwd}`);
        return ok({ agent: info });
      }
      case "attach": {
        const snapshot = await agents.snapshot(agent);
        if (snapshot === undefined) return fail(`no agent ${agent}`);
        ws.data.attached.add(agent);
        return send(ws, { type: "history", id: msg.id, agent, info: agents.info(agent), messages: snapshot.messages.map(light), live: snapshot.live });
      }
      case "detach":
        ws.data.attached.delete(agent);
        return ok();
      case "prompt":
      case "steer":
      case "follow_up":
      case "abort": {
        const reply = await agents.send(agent, { type: msg.type, text: msg.text, images: msg.images });
        return reply.type === "ok" ? ok({ text: reply.text }) : fail(reply.detail ?? "refused");
      }
      case "stop":
        return agents.stop(agent) ? ok() : fail(`no agent ${agent}`);
      default:
        return fail(`unknown message type: ${String(msg.type)}`);
    }
  }

  const server = Bun.serve<Socket>({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/health") return Response.json({ name: "kinoko", version: opts.version, protocol: PROTOCOL });
      if (url.pathname === "/v1/pair" && req.method === "POST") {
        const now = Date.now();
        failures = failures.filter((t) => now - t < 60_000);
        if (failures.length >= 10) return Response.json({ error: "too many attempts: wait a minute" }, { status: 429 });
        const body = (await req.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
        const paired = typeof body.code === "string" ? await opts.devices.pair(body.code, typeof body.name === "string" ? body.name : "phone") : undefined;
        if (paired === undefined) {
          failures.push(now);
          return Response.json({ error: "that pairing code is wrong, used or expired: run `kinoko serve pair` for a new one" }, { status: 403 });
        }
        log(`paired ${paired.device.name} (${paired.device.id})`);
        return Response.json({ token: paired.token, device: { id: paired.device.id, name: paired.device.name }, version: opts.version, protocol: PROTOCOL });
      }
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
      const device = await opts.devices.check(token);
      if (device === undefined) return Response.json({ error: "not paired: scan the code from `kinoko serve pair`" }, { status: 401 });
      if (url.pathname === "/v1/ws") {
        if (srv.upgrade(req, { data: { device, attached: new Set<string>() } })) return undefined;
        return Response.json({ error: "expected a WebSocket" }, { status: 400 });
      }
      if (url.pathname === "/v1/agents") return Response.json({ agents: agents.list() });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      maxPayloadLength: 32 * 1024 * 1024, // a prompt may carry photos
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        sockets.add(ws);
        log(`${ws.data.device.name} connected`);
        send(ws, { type: "hello", version: opts.version, protocol: PROTOCOL, device: { id: ws.data.device.id, name: ws.data.device.name }, agents: agents.list() });
      },
      message(ws, raw) {
        let msg: Incoming;
        try {
          msg = JSON.parse(String(raw)) as Incoming;
        } catch {
          send(ws, { type: "error", detail: "not JSON" });
          return;
        }
        handle(ws, msg).catch((e: unknown) => send(ws, { type: "error", id: msg.id, detail: e instanceof Error ? e.message : String(e) }));
      },
      close(ws) {
        sockets.delete(ws);
        log(`${ws.data.device.name} disconnected`);
      },
    },
  });

  return {
    server,
    agents,
    stop: () => {
      agents.stopAll();
      void server.stop(true);
    },
  };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
