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
    const hub = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: join(dir, "sessions"), version: "t", spawn: fakeSpawn, render: (text, width) => [`${width}:${text}`] });
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

      c.send({ id: "w", type: "render", text: "```ts\nx\n```", width: 7 });
      expect(await c.next("rendered")).toEqual({ type: "rendered", id: "w", lines: ["20:```ts\nx\n```"] }); // at least 20 columns

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

  test("approvals: every device sees the pending call in the list, an attached one gets the events, approve reaches the agent once", async () => {
    // A child whose prompt runs a gated call and waits; approve settles it (the first one only).
    const answers: object[] = [];
    const spawn: Spawn = (_cmd, cwd): Child => {
      const out = pipe();
      const exit = { done: (_code: number): void => undefined };
      const emit = (event: object): void => out.push(JSON.stringify({ type: "event", event }));
      const call = { id: "c1", name: "bash", args: { command: "sudo ls" } };
      let waiting = false;
      return {
        write: (line) => {
          const c = JSON.parse(line) as { id: string; type: string; allow?: boolean };
          if (c.type === "get_state") out.push(JSON.stringify({ type: "ok", id: c.id, state: { running: false, model: "qwen", messages: 0, cwd } }));
          if (c.type === "get_messages") out.push(JSON.stringify({ type: "ok", id: c.id, messages: [] }));
          if (c.type === "prompt") {
            out.push(JSON.stringify({ type: "ok", id: c.id, text: "started" }));
            emit({ type: "run_start", prompt: "go" });
            emit({ type: "tool_start", call });
            emit({ type: "approval_request", id: "q1", call, reason: "sudo needs confirmation" });
            waiting = true;
          }
          if (c.type === "approve") {
            answers.push(c);
            if (!waiting) return out.push(JSON.stringify({ type: "error", id: c.id, detail: "not waiting: already answered" }));
            waiting = false;
            out.push(JSON.stringify({ type: "ok", id: c.id, text: c.allow ? "allowed" : "denied" }));
            emit({ type: "approval_end", id: "q1", allow: c.allow, by: "app" });
            emit({ type: "tool_end", call });
            emit({ type: "run_end", reason: "done" });
          }
        },
        lines: out.iter,
        errors: pipe().iter,
        exited: new Promise((r) => (exit.done = r)),
        kill: () => (out.end(), exit.done(0)),
      };
    };
    const devices = new Devices(join(dir, "approvals.json"));
    const hub = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: dir, version: "t", spawn });
    const pair = async (name: string): Promise<string> =>
      ((await (await fetch(`http://127.0.0.1:${hub.server.port}/v1/pair`, { method: "POST", body: JSON.stringify({ code: await devices.code(), name }) })).json()) as { token: string }).token;
    try {
      const phone = client(`ws://127.0.0.1:${hub.server.port}/v1/ws`, await pair("phone"));
      const tablet = client(`ws://127.0.0.1:${hub.server.port}/v1/ws`, await pair("tablet")); // never attached
      await phone.next("hello");
      await tablet.next("hello");
      phone.send({ id: "1", type: "start", cwd: dir });
      const id = ((await phone.next("ok")) as { agent: { id: string } }).agent.id;
      phone.send({ id: "2", type: "prompt", agent: id, text: "go" });
      expect(await phone.next("ok")).toMatchObject({ id: "2", text: "started" });

      type Listed = { agents: Array<{ approval?: { id: string; call: { id: string; name: string; args: object }; reason: string } }> };
      let listed = (await tablet.next("agents")) as Listed;
      // oxlint-disable-next-line no-await-in-loop -- the list is pushed on each change
      while (listed.agents[0]?.approval === undefined) listed = (await tablet.next("agents")) as Listed;
      expect(listed.agents[0]?.approval).toEqual({ id: "q1", call: { id: "c1", name: "bash", args: { command: "sudo ls" } }, reason: "sudo needs confirmation" });
      let e = (await phone.next("event")).event as { type: string };
      // oxlint-disable-next-line no-await-in-loop -- events arrive one after another
      while (e.type !== "approval_request") e = (await phone.next("event")).event as { type: string };

      phone.send({ id: "3", type: "approve", agent: id });
      expect(((await phone.next("error")) as { detail: string }).detail).toBe("approve needs request and allow");
      phone.send({ id: "4", type: "approve", agent: id, request: "q1", allow: true, remember: true });
      expect(await phone.next("ok")).toMatchObject({ id: "4", text: "allowed" });
      tablet.send({ id: "5", type: "approve", agent: id, request: "q1", allow: false });
      expect(((await tablet.next("error")) as { detail: string }).detail).toBe("not waiting: already answered");
      expect(answers[0]).toMatchObject({ type: "approve", request: "q1", allow: true, remember: true, by: "app" });

      // oxlint-disable-next-line no-await-in-loop -- the list is pushed on each change
      while (listed.agents[0]?.approval !== undefined) listed = (await tablet.next("agents")) as Listed;
      e = (await phone.next("event")).event as { type: string };
      // oxlint-disable-next-line no-await-in-loop -- events arrive one after another
      while (e.type !== "approval_end") e = (await phone.next("event")).event as { type: string };
      expect(e).toMatchObject({ type: "approval_end", id: "q1", allow: true, by: "app" });
      phone.close();
      tablet.close();
    } finally {
      hub.stop();
    }
  });

  test("files from the phone: saved here, named in the message; a picture also goes as an image", async () => {
    const got: Array<{ type: string; text?: string; images?: Array<{ mime: string }> }> = [];
    const spawn: Spawn = (_cmd, cwd): Child => {
      const out = pipe();
      const exit = { done: (_code: number): void => undefined };
      return {
        write: (line) => {
          const c = JSON.parse(line) as { id: string; type: string; text?: string; images?: Array<{ mime: string }> };
          if (c.type === "get_state") return out.push(JSON.stringify({ type: "ok", id: c.id, state: { running: false, model: "m", messages: 0, cwd } }));
          got.push(c);
          out.push(JSON.stringify({ type: "ok", id: c.id, text: "started" }));
        },
        lines: out.iter,
        errors: pipe().iter,
        exited: new Promise((r) => (exit.done = r)),
        kill: () => (out.end(), exit.done(0)),
      };
    };
    const devices = new Devices(join(dir, "uploads.json"));
    const uploads = join(dir, "uploads");
    const hub = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: dir, uploadsDir: uploads, version: "t", spawn });
    try {
      const { token } = (await (await fetch(`http://127.0.0.1:${hub.server.port}/v1/pair`, { method: "POST", body: JSON.stringify({ code: await devices.code(), name: "phone" }) })).json()) as { token: string };
      const c = client(`ws://127.0.0.1:${hub.server.port}/v1/ws`, token);
      await c.next("hello");
      c.send({ id: "1", type: "start", cwd: dir });
      const id = ((await c.next("ok")) as { agent: { id: string } }).agent.id;
      const png = Buffer.from("fake png bytes").toString("base64");
      const pdf = Buffer.from("%PDF-1.7 fake").toString("base64");
      c.send({ id: "2", type: "prompt", agent: id, text: "summarize these", files: [{ name: "shot.png", mime: "image/png", data: png }, { name: "../../report.pdf", mime: "application/pdf", data: pdf }, { name: "broken" }] });
      expect(await c.next("ok")).toMatchObject({ id: "2" });
      const prompt = got.find((g) => g.type === "prompt")!;
      const paths = [...(prompt.text ?? "").matchAll(/\[sent from the phone: (\S+) \((\d+) B\)\]/g)].map((m) => m[1]!);
      expect(prompt.text).toStartWith("summarize these\n\n[sent from the phone: ");
      expect(paths.length).toBe(2); // the broken one is left out
      expect(paths[0]).toEndWith("-1-shot.png");
      expect(paths[1]).toEndWith("-2-report.pdf"); // its own name only: no way out of the folder
      expect(paths.every((p) => p.startsWith(uploads))).toBe(true);
      expect(await Bun.file(paths[1]!).text()).toBe("%PDF-1.7 fake");
      expect(prompt.images).toEqual([{ mime: "image/png", data: png }] as never);
      // A file alone, with no text: the message is where it is.
      c.send({ id: "3", type: "prompt", agent: id, files: [{ name: "notes.txt", mime: "text/plain", data: Buffer.from("hi").toString("base64") }] });
      await c.next("ok");
      expect(got.filter((g) => g.type === "prompt")[1]?.text).toMatch(/^\[sent from the phone: \S+-notes\.txt \(2 B\)\]$/);
      c.close();
    } finally {
      hub.stop();
    }
  });

  test("background jobs: the agent says how many run, the list carries it (none: no field), never replayed", async () => {
    let emit = (_e: object): void => undefined;
    const spawn: Spawn = (_cmd, cwd): Child => {
      const out = pipe();
      const exit = { done: (_code: number): void => undefined };
      emit = (event) => out.push(JSON.stringify({ type: "event", event }));
      return {
        write: (line) => {
          const c = JSON.parse(line) as { id: string; type: string };
          if (c.type === "get_state") out.push(JSON.stringify({ type: "ok", id: c.id, state: { running: false, model: "m", messages: 0, cwd } }));
          if (c.type === "get_messages") out.push(JSON.stringify({ type: "ok", id: c.id, messages: [] }));
        },
        lines: out.iter,
        errors: pipe().iter,
        exited: new Promise((r) => (exit.done = r)),
        kill: () => (out.end(), exit.done(0)),
      };
    };
    const changes: number[] = [];
    const hub = serve({ port: 0, devices: new Devices(join(dir, "jobs.json")), command: ["kinoko"], sessionsDir: dir, version: "t", spawn });
    try {
      const info = hub.agents.start({ cwd: dir });
      await Bun.sleep(20);
      emit({ type: "jobs", running: 2 });
      await Bun.sleep(20);
      changes.push(hub.agents.info(info.id)?.jobs ?? 0);
      emit({ type: "jobs", running: 0 });
      await Bun.sleep(20);
      expect(changes).toEqual([2]);
      expect(hub.agents.info(info.id)?.jobs).toBeUndefined();
      expect((await hub.agents.snapshot(info.id))?.live).toEqual([]);
    } finally {
      hub.stop();
    }
  });
});

