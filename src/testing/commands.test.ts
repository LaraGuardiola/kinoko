import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../jobs.ts";
import type { Catalog, Entry } from "../catalog.ts";
import { EXTENSIONS } from "../catalog.ts";
import { commandList, runCommand } from "../commands.ts";
import type { CommandHost } from "../commands.ts";
import { Agent } from "../loop.ts";
import { Rpc } from "../rpc.ts";
import type { RpcReply } from "../rpc.ts";

const signal = new AbortController().signal;
const agent = (): Agent => new Agent({ provider: { stream: async function* () {} } as never, model: "m", system: "", tools: [], maxTurns: 2, maxCost: 1 });

function fakeCatalog(entries: Entry[], offline = false): { store: Catalog; log: string[] } {
  const log: string[] = [];
  const find = (name: string): Entry | undefined => entries.find((e) => e.name === name);
  return {
    log,
    store: {
      kind: EXTENSIONS,
      repo: "r",
      local: async () => entries.map((e) => ({ ...e })),
      list: async () => (offline ? Promise.reject(new Error("could not fetch r: offline")) : entries.map((e) => ({ ...e }))),
      install: async (name) => {
        log.push(`install ${name}`);
        Object.assign(find(name) ?? {}, { installed: true, enabled: true });
        return { ok: true, note: `${name} installed` };
      },
      remove: async (name) => {
        log.push(`remove ${name}`);
        Object.assign(find(name) ?? {}, { installed: false });
        return { ok: true, note: `${name} removed` };
      },
      enable: async (name, on) => {
        log.push(`${on ? "on" : "off"} ${name}`);
        Object.assign(find(name) ?? {}, { enabled: on });
        return { ok: true, note: `${name} ${on ? "on" : "off"}` };
      },
    },
  };
}

describe("slash commands for the phone", () => {
  test("only those the host can do are listed", () => {
    expect(commandList({ agent: agent() }).map((c) => c.name)).toEqual(["compact", "models", "clear", "help"]);
    const full: CommandHost = { agent: agent(), newSession: async () => undefined, thinking: { current: () => "low", set: () => "" }, catalogs: { extensions: fakeCatalog([]).store }, session: () => "", fork: async () => "" };
    expect(commandList(full).map((c) => [c.name, c.kind])).toEqual([
      ["new", "run"], ["compact", "run"], ["thinking", "list"], ["models", "list"], ["extensions", "list"], ["profile", "list"], ["session", "run"], ["clear", "run"], ["fork", "run"], ["help", "run"],
    ]);
  });

  test("thinking: the profiles with the one in use; choosing one says so, and the terminal hears it", async () => {
    let current = "low";
    const told: string[] = [];
    const host: CommandHost = { agent: agent(), thinking: { current: () => current, set: (n) => ((current = n), `thinking: ${n}`) }, told: (n) => told.push(n) };
    expect((await runCommand(host, "thinking", "", signal)).items?.find((i) => i.current)?.name).toBe("low");
    const chosen = await runCommand(host, "thinking", "high", signal);
    expect(chosen.text).toBe("thinking: high");
    expect(chosen.items?.find((i) => i.current)?.name).toBe("high");
    expect(told).toEqual(["thinking: high"]);
  });

  test("extensions: listed with their state; switched off and on, removed, installed, each applied", async () => {
    const { store, log } = fakeCatalog([
      { name: "web", description: "web tools", installed: true, enabled: true },
      { name: "mermaid", description: "diagrams", installed: false },
    ]);
    const applied: string[] = [];
    const host: CommandHost = { agent: agent(), catalogs: { extensions: store }, apply: async (_k, name, change) => (applied.push(`${change} ${name}`), "done") };
    const listed = await runCommand(host, "extensions", "", signal);
    expect(listed.items).toEqual([
      { name: "web", description: "web tools", installed: true, current: true, off: false, shared: false },
      { name: "mermaid", description: "diagrams", installed: false, current: false, off: false, shared: false },
    ]);
    const off = await runCommand(host, "extensions", "off web", signal);
    expect(off.text).toBe("web off: done");
    expect(off.items?.[0]).toMatchObject({ current: false, off: true });
    await runCommand(host, "extensions", "on web", signal);
    await runCommand(host, "extensions", "install mermaid", signal);
    await runCommand(host, "extensions", "remove web", signal);
    expect(log).toEqual(["off web", "on web", "install mermaid", "remove web"]);
    expect(applied).toEqual(["disable web", "enable web", "install mermaid", "remove web"]);
  });

  test("offline: the list on this computer, and why", async () => {
    const host: CommandHost = { agent: agent(), catalogs: { skills: fakeCatalog([{ name: "x", description: "", installed: true, enabled: true }], true).store } };
    const result = await runCommand(host, "skills", "", signal);
    expect(result.items?.map((i) => i.name)).toEqual(["x"]);
    expect(result.hint).toBe("could not fetch r: offline · showing what is on this computer");
  });

  test("new resets the conversation; unknown commands say so", async () => {
    let fresh = false;
    const host: CommandHost = { agent: agent(), newSession: async () => void (fresh = true) };
    expect(await runCommand(host, "new", "", signal)).toEqual({ text: "new session: the model starts with no history", reset: true });
    expect(fresh).toBe(true);
    expect((await runCommand(host, "dance", "", signal)).text).toBe("no command /dance here");
    expect((await runCommand(host, "compact", "", signal)).text).toBe("nothing to compact yet");
  });

  test("models: the provider's, the one in use marked and always there; picking one switches", async () => {
    const a = new Agent({ provider: { stream: async function* () {}, models: async () => ["qwen", "gemma"] } as never, model: "llama", system: "", tools: [], maxTurns: 2, maxCost: 1 });
    const listed = await runCommand({ agent: a }, "models", "", signal);
    expect(listed.items?.map((i) => [i.name, i.current])).toEqual([["llama", true], ["qwen", false], ["gemma", false]]);
    const picked = await runCommand({ agent: a }, "models", "gemma", signal);
    expect(a.model).toBe("gemma");
    expect(picked.text).toBe("model: gemma from the next request");
    expect(picked.items?.find((i) => i.current)?.name).toBe("gemma");
  });

  test("clear wipes the view (and the TUI's screen); help lists the commands; fork replaces the conversation", async () => {
    let cleared = false;
    const host: CommandHost = { agent: agent(), clear: () => void (cleared = true), fork: async () => "fork: head moved" };
    expect(await runCommand(host, "clear", "", signal)).toEqual({ text: "cleared: the context stays", clear: true });
    expect(cleared).toBe(true);
    expect((await runCommand(host, "help", "", signal)).text).toContain("/fork  Move the session head back one message");
    expect(await runCommand(host, "fork", "", signal)).toEqual({ text: "fork: head moved", reset: true });
  });

  test("through the rpc mode: get_commands and command", async () => {
    const lines: RpcReply[] = [];
    let current = "low";
    const rpc = new Rpc({ agent: agent(), model: "m", commands: { agent: agent(), thinking: { current: () => current, set: (n) => ((current = n), `thinking: ${n}`) } }, write: (t) => lines.push(JSON.parse(t) as RpcReply) });
    rpc.handle(JSON.stringify({ type: "get_commands", id: "c" }));
    expect(lines[0]?.commands?.map((c) => c.name)).toEqual(["compact", "thinking", "models", "clear", "help"]);
    rpc.handle(JSON.stringify({ type: "command", id: "t", name: "thinking", arg: "medium" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(lines[1]).toMatchObject({ type: "ok", id: "t", result: { text: "thinking: medium" } });
    const bare = new Rpc({ agent: agent(), model: "m", write: (t) => lines.push(JSON.parse(t) as RpcReply) });
    bare.handle(JSON.stringify({ type: "command", id: "x", name: "new" }));
    expect(lines.at(-1)).toEqual({ type: "error", id: "x", detail: "no commands here" });
  });

  test("jobs: the shells, the running ones first; one of them is its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinoko-cmd-jobs-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const jobs = new Jobs({ dir, onEnd: () => undefined });
    const host: CommandHost = { agent: agent(), jobs };
    expect(commandList(host).map((c) => c.name)).toContain("jobs");
    expect((await runCommand(host, "jobs", "", signal)).hint).toContain("no shells yet");

    const quick = jobs.start("printf 'one\\ntwo\\n'", dir);
    await jobs.ended(quick.id);
    // The only one there is: its output at once.
    expect(await runCommand(host, "jobs", "", signal)).toMatchObject({ title: expect.stringMatching(/^#1 · done after/), text: "one\ntwo", hint: "$ printf 'one\\ntwo\\n'" });

    const slow = jobs.start("sleep 30", dir);
    const list = await runCommand(host, "jobs", "", signal);
    expect(list.title).toBe("Shells");
    expect(list.items?.map((i) => [i.name, i.current])).toEqual([["#2", true], ["#1", false]]);
    expect(list.items?.[0]?.description).toMatch(/^sleep 30 · running/);
    expect(await runCommand(host, "jobs", "#2", signal)).toMatchObject({ title: expect.stringMatching(/^#2 · running/), text: "(nothing printed yet)" });
    expect((await runCommand(host, "jobs", "#9", signal)).text).toBe("no shell #9");
    // Stopped from the phone: it ends (what it started too), and the answer is its window.
    expect((await runCommand(host, "jobs", "stop #2", signal)).title).toMatch(/^#2 · killed after/);
    await jobs.ended(slow.id);
    expect(jobs.list().find((j) => j.id === slow.id)?.state).toBe("killed");
    expect((await runCommand(host, "jobs", "stop #2", signal)).title).toMatch(/^#2 · killed after/); // again: nothing more
    expect((await runCommand(host, "jobs", "stop #9", signal)).text).toBe("no shell #9");
  });
});
