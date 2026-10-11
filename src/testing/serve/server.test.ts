import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Child, Spawn } from "../../serve/agents.ts";
import { Devices } from "../../serve/devices.ts";
import { serve } from "../../serve/server.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-serve-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Lines pushed in, read out as an async iterable. */
function pipe(): { push: (line: string) => void; end: () => void; iter: AsyncIterable<string> } {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push: (line) => (queue.push(line), wake?.()),
    end: () => ((done = true), wake?.()),
    iter: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift() ?? "";
          if (done) return;
          // oxlint-disable-next-line no-await-in-loop -- a stream waits for its next line
          await new Promise<void>((r) => (wake = r));
        }
      },
    },
  };
}

/** A `kinoko --mode rpc` that answers like the real one: a prompt streams a reply. */
const spawns: Array<{ cmd: string[]; cwd: string }> = [];
const fakeSpawn: Spawn = (cmd, cwd): Child => {
  spawns.push({ cmd, cwd });
  const out = pipe();
  const err = pipe();
  const exit = { done: (_code: number): void => undefined };
  const messages: object[] = [];
  const emit = (event: object): void => out.push(JSON.stringify({ type: "event", event }));
  return {
    write: (line) => {
      const c = JSON.parse(line) as { id: string; type: string; text?: string };
      if (c.type === "get_state") out.push(JSON.stringify({ type: "ok", id: c.id, state: { running: false, model: "qwen", messages: 0, session: "s-1", cwd } }));
      if (c.type === "get_messages") out.push(JSON.stringify({ type: "ok", id: c.id, messages }));
      if (c.type === "get_commands") out.push(JSON.stringify({ type: "ok", id: c.id, commands: [{ name: "thinking", description: "d", kind: "list" }] }));
      if (c.type === "command") out.push(JSON.stringify({ type: "ok", id: c.id, result: { text: `ran ${(c as { name?: string }).name} ${(c as { arg?: string }).arg}` } }));
      if (c.type === "prompt") {
        out.push(JSON.stringify({ type: "ok", id: c.id, text: "started" }));
        messages.push({ id: "u", role: "user", content: c.text, images: [{ mime: "image/png", data: "QUJDRA==" }] });
        emit({ type: "run_start", prompt: c.text });
        emit({ type: "message_delta", delta: "ho" });
        emit({ type: "message_delta", delta: "la" });
        const reply = { id: "a", role: "assistant", content: "hola" };
        messages.push(reply);
        emit({ type: "message_end", message: reply });
        emit({ type: "run_end", reason: "done" });
      }
    },
    lines: out.iter,
    errors: err.iter,
    exited: new Promise((r) => (exit.done = r)),
    kill: () => (out.end(), err.end(), exit.done(0)),
  };
};

function client(url: string, token: string): { next: (type: string) => Promise<Record<string, unknown>>; send: (msg: object) => void; close: () => void } {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  const inbox: Record<string, unknown>[] = [];
  const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
    const w = waiters.findIndex((x) => x.type === msg.type);
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((r) => ws.addEventListener("open", r, { once: true }));
  return {
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0] ?? {});
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send: (msg) => void opened.then(() => ws.send(JSON.stringify(msg))),
    close: () => ws.close(),
  };
}

describe("serve: the hub", () => {
  test("pairing, then a device starts an agent, prompts it, sees it stream, attaches again, stops it", async () => {
    const devices = new Devices(join(dir, "serve.json"));
    const hub = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: join(dir, "sessions"), version: "t", spawn: fakeSpawn });
    const base = `http://127.0.0.1:${hub.server.port}`;
    try {
      expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({ name: "kinoko", version: "t", protocol: 1 });
      expect((await fetch(`${base}/v1/agents`)).status).toBe(401);
      const wrong = await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: "nope" }) });
      expect(wrong.status).toBe(403);
      const { token } = (await (await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: await devices.code(), name: "phone" }) })).json()) as { token: string };

      const c = client(`ws://127.0.0.1:${hub.server.port}/v1/ws`, token);
      expect((await c.next("hello")).device).toMatchObject({ name: "phone" });
      c.send({ id: "1", type: "start", cwd: dir });
      const started = (await c.next("ok")) as { agent: { id: string } };
      const id = started.agent.id;
      expect(spawns.at(-1)).toEqual({ cmd: ["kinoko", "--mode", "rpc"], cwd: dir });
      let agents = (await c.next("agents")) as { agents: Array<{ state: string; model: string; session?: string }> };
      // oxlint-disable-next-line no-await-in-loop -- the list is pushed again once the agent is up
      while (agents.agents[0]?.state === "starting") agents = (await c.next("agents")) as typeof agents;
      expect(agents.agents[0]).toMatchObject({ state: "idle", model: "qwen", session: "s-1" });

      c.send({ id: "2", type: "prompt", agent: id, text: "di hola" });
      const deltas: string[] = [];
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- events arrive one after another
        const e = (await c.next("event")).event as { type: string; delta?: string; message?: { content: string } };
        if (e.type === "message_delta") deltas.push(e.delta ?? "");
        if (e.type === "run_end") break;
      }
      expect(deltas.join("")).toBe("hola");
      // The list says how the run ended and what it said: what the phone's notification shows.
      let after = (await c.next("agents")) as { agents: Array<{ state: string; ended?: string; last?: string }> };
      // oxlint-disable-next-line no-await-in-loop -- the list is pushed again until the run is over
      while (after.agents[0]?.state !== "idle") after = (await c.next("agents")) as typeof after;
      expect(after.agents[0]).toMatchObject({ ended: "done", last: "hola" });

      c.send({ id: "3", type: "attach", agent: id });
      const history = (await c.next("history")) as { messages: Array<{ role: string; images?: Array<{ mime: string; data: string; size: number }> }>; live: unknown[] };
      expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(history.messages[0]?.images).toEqual([{ mime: "image/png", data: "", size: 6 }]); // bytes stay home
      expect(history.live).toEqual([]);

      c.send({ id: "c", type: "commands", agent: id });
      expect(((await c.next("commands")) as { commands: Array<{ name: string }> }).commands.map((x) => x.name)).toEqual(["thinking"]);
      c.send({ id: "r", type: "command", agent: id, name: "thinking", arg: "high" });
      expect(await c.next("command_result")).toMatchObject({ id: "r", agent: id, result: { text: "ran thinking high" } });

      c.send({ id: "4", type: "stop", agent: id });
      await c.next("ok");
      c.send({ id: "5", type: "prompt", agent: id, text: "x" });
      expect(((await c.next("error")) as { detail: string }).detail).toBe(`no agent ${id}`);
      c.send({ id: "6", type: "start", cwd: join(dir, "missing") });
      expect(((await c.next("error")) as { detail: string }).detail).toStartWith("no directory");
      c.close();
    } finally {
      hub.stop();
    }
  });

  test("resume and model reach the child's command line", async () => {
    const hub = serve({ port: 0, devices: new Devices(join(dir, "x.json")), command: ["bun", "main.ts"], sessionsDir: dir, version: "t", spawn: fakeSpawn });
    try {
      hub.agents.start({ cwd: dir, session: "continue", model: "m1" });
      expect(spawns.at(-1)?.cmd).toEqual(["bun", "main.ts", "--mode", "rpc", "--continue", "--model", "m1"]);
      hub.agents.start({ cwd: dir, session: "abc" });
      expect(spawns.at(-1)?.cmd).toEqual(["bun", "main.ts", "--mode", "rpc", "--session", "abc"]);
    } finally {
      hub.stop();
    }
  });
});
