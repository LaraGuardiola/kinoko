// `kinoko serve`'s HTTP and WebSocket server, on localhost (Tailscale brings the phone in) and,
// encrypted with its own certificate, on the local network. The
// protocol is in docs/protocol.md: pairing over HTTP, then one WebSocket per device carrying JSON
// messages both ways: the agent list, agents started, attached to, prompted, aborted, stopped.

import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import type { AgentEvent } from "../loop.ts";
import type { Image, Message } from "../types.ts";
import { Agents, lineQueue } from "./agents.ts";
import type { Child, Hello, Spawn } from "./agents.ts";
import type { Device, Devices } from "./devices.ts";
import type { Identity } from "./tls.ts";
import { expandHome, folders } from "./dirs.ts";
import { projects } from "./projects.ts";
import { saveUploads, uploadsOf, withUploads } from "./uploads.ts";

export const PROTOCOL = 1;

/** Told of every agent's events (the bridge). */
export type Watcher = (agent: string, event: AgentEvent) => void;

interface Socket {
  device: Device;
  attached: Set<string>;
}

export interface ServeOptions {
  port: number;
  /** The profile in use (~/.kinoko/profile.json): the phone draws its mushroom. */
  profile?: () => string | undefined;
  devices: Devices;
  /** How to run kinoko (the binary, or bun and main.ts). */
  command: string[];
  sessionsDir: string;
  /** Where files sent from the phone are saved (default: beside the sessions, ~/.kinoko/uploads). */
  uploadsDir?: string;
  version: string;
  /** The Unix socket kinoko TUIs link themselves through (link.ts); none, no links. */
  socket?: string;
  /** Draws markdown (a fenced block, a table) as the TUI would, `width` columns wide: ANSI rows. */
  render?: (text: string, width: number) => string[] | Promise<string[]>;
  host?: string;
  /** The local network too: listened on with TLS (the hub's own certificate), the app pins it. */
  lan?: { port: number; host?: string; identity: Identity; urls: string[] };
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
  files?: unknown; // prompt, steer, follow_up: files to save here and name in the message
  name?: string;
  arg?: string;
  width?: number;
  request?: string; // approve: the approval_request's id
  allow?: boolean;
  remember?: boolean;
  path?: string; // folders: what was typed so far
};

export function serve(opts: ServeOptions): { server: Server<Socket>; lan?: Server<Socket>; agents: Agents; watch: (listener: Watcher) => () => void; announce: (msg: object) => void; stop: () => void } {
  const sockets = new Set<ServerWebSocket<Socket>>();
  // Every agent's events, attached or not: the Telegram bridge listens here.
  const watchers = new Set<Watcher>();
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
      for (const w of watchers) w(id, event);
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
      case "folders": {
        const path = typeof msg.path === "string" ? msg.path : "";
        return send(ws, { type: "folders", id: msg.id, path, folders: await folders(path) });
      }
      case "start": {
        const cwd = typeof msg.cwd === "string" ? expandHome(msg.cwd) : undefined;
        if (cwd === undefined || !(await isDir(cwd))) return fail(`no directory ${String(msg.cwd)}`);
        const info = agents.start({ cwd, session: msg.session, model: msg.model });
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
        // Files from the phone: saved on this computer first, the message says where.
        const files = uploadsOf(msg.files);
        const up = files.length > 0 ? await saveUploads(opts.uploadsDir ?? join(opts.sessionsDir, "..", "uploads"), files) : undefined;
        if (up) log(`${ws.data.device.name} sent ${up.saved.map((f) => f.path).join(", ")}`);
        const images = [...(msg.images ?? []), ...(up?.images ?? [])];
        const text = up ? withUploads(msg.text ?? "", up.saved) : msg.text;
        const reply = await agents.send(agent, { type: msg.type, text, images: images.length > 0 ? images : undefined });
        return reply.type === "ok" ? ok({ text: reply.text }) : fail(reply.detail ?? "refused");
      }
      case "approve": {
        // The first answer wins: one that comes late (the terminal answered) is refused.
        if (typeof msg.request !== "string" || typeof msg.allow !== "boolean") return fail("approve needs request and allow");
        const reply = await agents.send(agent, { type: "approve", request: msg.request, allow: msg.allow, remember: msg.remember === true, by: "app" });
        if (reply.type === "ok") log(`${ws.data.device.name} ${msg.allow ? "allowed" : "denied"} a call of ${agent}`);
        return reply.type === "ok" ? ok({ text: reply.text }) : fail(reply.detail ?? "refused");
      }
      case "commands": {
        const reply = await agents.send(agent, { type: "get_commands" });
        return reply.type === "ok" ? send(ws, { type: "commands", id: msg.id, agent, commands: reply.commands ?? [] }) : fail(reply.detail ?? "refused");
      }
      case "command": {
        const reply = await agents.send(agent, { type: "command", name: msg.name, arg: msg.arg });
        return reply.type === "ok" ? send(ws, { type: "command_result", id: msg.id, agent, result: reply.result ?? {} }) : fail(reply.detail ?? "refused");
      }
      case "render": {
        // A code block, a diff, a tree, a diagram, a table: drawn here exactly as in the terminal.
        if (opts.render === undefined || typeof msg.text !== "string") return fail("nothing renders here");
        const width = Math.max(20, Math.min(200, Math.trunc(Number(msg.width) || 80)));
        return send(ws, { type: "rendered", id: msg.id, lines: await opts.render(msg.text.slice(0, 200_000), width) });
      }
      case "stop": {
        const result = agents.stop(agent);
        if (result === "terminal") return fail("this agent runs in a terminal: it stops there");
        return result === "stopped" ? ok() : fail(`no agent ${agent}`);
      }
      default:
        return fail(`unknown message type: ${String(msg.type)}`);
    }
  }

  // Where else the app can reach this hub: the local network, encrypted, its certificate pinned.
  const lan = opts.lan ? { urls: opts.lan.urls, fingerprint: opts.lan.identity.fingerprint } : undefined;

  // The same hub on each address it listens on: here (Tailscale brings the phone in), and the LAN.
  const listen = (where: { hostname: string; port: number; tls?: { cert: string; key: string } }): Server<Socket> =>
    Bun.serve<Socket>({
      ...where,
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
          return Response.json({ token: paired.token, device: { id: paired.device.id, name: paired.device.name }, version: opts.version, protocol: PROTOCOL, ...(lan ? { lan } : {}) });
        }
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
        const device = await opts.devices.check(token);
        if (device === undefined) return Response.json({ error: "not paired: scan the code from `kinoko serve pair`" }, { status: 401 });
        if (url.pathname === "/v1/ws") {
          if (srv.upgrade(req, { data: { device, attached: new Set<string>() } })) return undefined;
          return Response.json({ error: "expected a WebSocket" }, { status: 400 });
        }
        if (url.pathname === "/v1/agents") return Response.json({ agents: agents.list() });
        // The app's "Forget this computer": the device unpairs itself, so this side forgets it too.
        if (url.pathname === "/v1/device" && req.method === "DELETE") {
          await opts.devices.revoke(device.id);
          for (const ws of sockets) if (ws.data.device.id === device.id) ws.close(4001, "unpaired");
          log(`${device.name} unpaired itself (${device.id})`);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
      websocket: {
        maxPayloadLength: 32 * 1024 * 1024, // a prompt may carry photos
        idleTimeout: 120,
        sendPings: true,
        open(ws) {
          sockets.add(ws);
          log(`${ws.data.device.name} connected`);
          send(ws, { type: "hello", version: opts.version, protocol: PROTOCOL, device: { id: ws.data.device.id, name: ws.data.device.name }, agents: agents.list(), ...(lan ? { lan } : {}), ...(opts.profile?.() ? { profile: opts.profile() } : {}) });
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

  const server = listen({ hostname: opts.host ?? "127.0.0.1", port: opts.port });
  let lanServer: Server<Socket> | undefined;
  if (opts.lan) {
    try {
      lanServer = listen({ hostname: opts.lan.host ?? "0.0.0.0", port: opts.lan.port, tls: { cert: opts.lan.identity.cert, key: opts.lan.identity.key } });
    } catch (e) {
      log(`the local network: cannot listen on port ${opts.lan.port} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Terminals linking in are a bonus: a socket that cannot be opened (a path too long for one,
  // a read-only home) leaves the phone side working, and says so.
  let links: { stop: () => void } | undefined;
  if (opts.socket !== undefined) {
    try {
      links = listenForTerminals(opts.socket, agents, log);
    } catch (e) {
      log(`terminals cannot link (${opts.socket}: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  return {
    server,
    ...(lanServer ? { lan: lanServer } : {}),
    agents,
    watch: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    /** Said to every device connected (the profile changed). */
    announce: broadcast,
    stop: () => {
      agents.stopAll();
      links?.stop();
      void server.stop(true);
      void lanServer?.stop(true);
    },
  };
}

interface Link {
  buffer: string;
  queue: ReturnType<typeof lineQueue>;
  closed: () => void;
  linked: boolean;
  child: Child;
}

/** The socket a kinoko TUI links itself through: its first line says who it is, the rest is rpc. */
function listenForTerminals(path: string, agents: Agents, log: (line: string) => void): { stop: () => void } {
  mkdirSync(dirname(path), { recursive: true }); // a first run: ~/.kinoko may not be there yet
  try {
    unlinkSync(path); // a socket left by a hub that died
  } catch {
    // none
  }
  const listener = Bun.listen<Link>({
    unix: path,
    socket: {
      open(socket) {
        const settle: { closed: () => void } = { closed: () => undefined };
        const exited = new Promise<number>((resolve) => (settle.closed = () => resolve(0)));
        const queue = lineQueue();
        const child: Child = {
          write: (line) => void socket.write(`${line}\n`),
          lines: queue.lines,
          errors: lineQueue().lines,
          exited,
          kill: () => socket.end(),
        };
        socket.data = { buffer: "", queue, closed: () => settle.closed(), linked: false, child };
      },
      data(socket, chunk) {
        const link = socket.data;
        link.buffer += chunk.toString();
        let at = link.buffer.indexOf("\n");
        while (at >= 0) {
          const line = link.buffer.slice(0, at).trim();
          link.buffer = link.buffer.slice(at + 1);
          at = link.buffer.indexOf("\n");
          if (line === "") continue;
          if (link.linked) {
            link.queue.push(line);
            continue;
          }
          try {
            const hello = JSON.parse(line) as Hello & { type?: string };
            if (hello.type !== "hello" || typeof hello.cwd !== "string") throw new Error("no hello");
            link.linked = true;
            const info = agents.link(link.child, hello);
            log(`a terminal linked: ${info.project} (${info.id})`);
          } catch {
            socket.end(); // not a kinoko
          }
        }
      },
      close(socket) {
        socket.data.queue.end();
        socket.data.closed();
      },
    },
  });
  chmodSync(path, 0o600); // only this user's processes may link
  return {
    stop: () => {
      listener.stop(true);
      try {
        unlinkSync(path);
      } catch {
        // gone already
      }
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
