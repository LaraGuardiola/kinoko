// A kinoko in a terminal, linked to `kinoko serve`: while the hub runs, the TUI shows up in the
// phone app as an agent, which the phone follows live and talks to (a prompt from it runs here, and
// the terminal shows it). The link is the hub's Unix socket (~/.kinoko/serve.sock, mode 600), the
// language the rpc mode's: JSONL commands in, events and replies out. No hub, no link; a hub that
// starts later, or restarts, is found within a few seconds. KINOKO_LINK=0 keeps a terminal out.

import { stat } from "node:fs/promises";
import type { Socket } from "bun";
import type { CommandHost } from "../commands.ts";
import type { Agent } from "../loop.ts";
import { Rpc } from "../rpc.ts";

/** How often the TUI looks for a hub when it has none. */
const LOOK_MS = 3_000;

export interface LinkOptions {
  agent: Agent;
  socket: string;
  cwd: string;
  model: () => string;
  session: () => string;
  /** The TUI's own command host: the phone's slash commands run through it. */
  commands?: CommandHost;
}

/** Keeps the TUI linked to the hub while one runs. Returns a function that ends it. */
export function linkToHub(opts: LinkOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let conn: Socket<undefined> | undefined;

  const later = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void attempt(), LOOK_MS);
    timer.unref?.(); // looking never keeps kinoko alive
  };

  async function attempt(): Promise<void> {
    if (stopped) return;
    const there = await stat(opts.socket).then((s) => s.isSocket()).catch(() => false);
    if (!there) return later();
    let rpc: Rpc | undefined;
    let buffer = "";
    try {
      conn = await Bun.connect({
        unix: opts.socket,
        socket: {
          open(socket) {
            const write = (text: string): void => void socket.write(text);
            rpc = new Rpc({ agent: opts.agent, model: opts.model, session: opts.session, cwd: opts.cwd, commands: opts.commands, write });
            write(`${JSON.stringify({ type: "hello", origin: "terminal", pid: process.pid, cwd: opts.cwd, model: opts.model(), session: opts.session(), running: opts.agent.state === "running" })}\n`);
          },
          data(_socket, chunk) {
            buffer += chunk.toString();
            let at = buffer.indexOf("\n");
            while (at >= 0) {
              const line = buffer.slice(0, at).trim();
              buffer = buffer.slice(at + 1);
              if (line !== "") rpc?.handle(line);
              at = buffer.indexOf("\n");
            }
          },
          close() {
            rpc?.dispose();
            rpc = undefined;
            conn = undefined;
            later();
          },
          error() {
            // close follows
          },
        },
      });
    } catch {
      later(); // a stale socket file, a hub on its way down
    }
  }

  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    conn?.end();
  };
}

/** Whether a hub listens on `socket` (a connection opened and closed at once, never a hello). */
export async function hubRunning(socket: string): Promise<boolean> {
  try {
    const conn = await Bun.connect({ unix: socket, socket: { data: () => undefined } });
    conn.end();
    return true;
  } catch {
    return false;
  }
}
