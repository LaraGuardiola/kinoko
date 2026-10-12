import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../loop.ts";
import { Devices } from "../../serve/devices.ts";
import { hubSocket, isPipe, linkToHub } from "../../serve/link.ts";
import { serve } from "../../serve/server.ts";
import type { StreamEvent } from "../../types.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-link-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A provider that answers every request with "hola", slowly enough to be seen running. */
const provider = {
  stream: async function* (req: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    for (const delta of ["ho", "la"]) {
      // oxlint-disable-next-line no-await-in-loop -- a stream, one delta after another
      await new Promise((r) => setTimeout(r, 30));
      if (req.signal.aborted) return;
      yield { type: "text", delta };
    }
    yield { type: "done", stop: "end" };
  },
};

async function until<T>(get: () => T | undefined, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out");
    // oxlint-disable-next-line no-await-in-loop -- polling is the point
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("serve: a terminal linked to the hub", () => {
  test("shows up as a terminal agent, runs a prompt from the phone, refuses to be stopped by it, leaves when it closes", async () => {
    const socket = hubSocket(dir); // a named pipe on Windows
    const devices = new Devices(join(dir, "serve.json"));
    const hub = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: dir, version: "t", socket });
    const agent = new Agent({ provider, model: "qwen", system: "", tools: [], maxTurns: 4, maxCost: 10 });
    await agent.prompt("from the terminal"); // a conversation that started before the link
    const unlink = linkToHub({ agent, socket, cwd: "/home/me/kinoko", model: () => agent.model, session: () => "s-tui" });
    try {
      const linked = await until(() => hub.agents.list().find((a) => a.origin === "terminal" && a.title !== undefined));
      expect(linked).toMatchObject({ origin: "terminal", project: "kinoko", model: "qwen", session: "s-tui", state: "idle", title: "from the terminal" });

      const { token } = (await (await fetch(`http://127.0.0.1:${hub.server.port}/v1/pair`, { method: "POST", body: JSON.stringify({ code: await devices.code(), name: "phone" }) })).json()) as { token: string };
      const ws = new WebSocket(`ws://127.0.0.1:${hub.server.port}/v1/ws`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
      const inbox: Array<Record<string, unknown>> = [];
      ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data)) as Record<string, unknown>));
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      ws.send(JSON.stringify({ id: "a", type: "attach", agent: linked.id }));
      const history = await until(() => inbox.find((m) => m.type === "history"));
      expect((history.messages as Array<{ content: string }>).map((m) => m.content)).toEqual(["from the terminal", "hola"]);

      ws.send(JSON.stringify({ id: "p", type: "prompt", agent: linked.id, text: "from the phone" }));
      await until(() => inbox.find((m) => m.type === "event" && (m.event as { type: string }).type === "run_end"));
      expect(agent.messages.map((m) => m.content)).toEqual(["from the terminal", "hola", "from the phone", "hola"]);

      ws.send(JSON.stringify({ id: "s", type: "stop", agent: linked.id }));
      expect((await until(() => inbox.find((m) => m.type === "error" && m.id === "s"))).detail).toBe("this agent runs in a terminal: it stops there");
      ws.close();

      unlink(); // the terminal quits
      await until(() => (hub.agents.list().length === 0 ? true : undefined));
    } finally {
      unlink();
      hub.stop();
    }
  });

  test("no hub, no link; a hub that starts later is found", async () => {
    const socket = hubSocket(join(dir, "late"));
    const agent = new Agent({ provider, model: "m", system: "", tools: [], maxTurns: 4, maxCost: 10 });
    const unlink = linkToHub({ agent, socket, cwd: "/p", model: () => "m", session: () => "s" });
    const hub = serve({ port: 0, devices: new Devices(join(dir, "x.json")), command: ["kinoko"], sessionsDir: dir, version: "t", socket });
    try {
      await until(() => hub.agents.list().find((a) => a.origin === "terminal"), 6000);
    } finally {
      unlink();
      hub.stop();
    }
  }, 10_000);
});

describe("where the hub listens for terminals", () => {
  test("a Unix socket in ~/.kinoko; on Windows a named pipe named after the home folder", () => {
    expect(hubSocket("/home/me", "linux")).toBe(join("/home/me", ".kinoko", "serve.sock"));
    const pipe = hubSocket("C:\\Users\\Me", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\kinoko-serve-[0-9a-z]+$/);
    expect(hubSocket("c:\\users\\me", "win32")).toBe(pipe); // the same home, whatever its case
    expect(hubSocket("C:\\Users\\Other", "win32")).not.toBe(pipe);
    expect(isPipe(pipe)).toBe(true);
    expect(isPipe("/home/me/.kinoko/serve.sock")).toBe(false);
  });
});
