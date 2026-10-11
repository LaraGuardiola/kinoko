import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Entry } from "../catalog.ts";
import { runCommand } from "../commands.ts";
import type { CommandHost } from "../commands.ts";
import { Agent } from "../loop.ts";
import { PROFILES, activeProfile, applyProfile, currentProfile, readProfiles } from "../profiles.ts";
import type { Profile } from "../profiles.ts";
import type { Provider } from "../types.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-profiles-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, ".kinoko"), { recursive: true });

/** A catalog in memory: what it lists, and every change made to it. */
function catalog(entries: Entry[]): { store: Catalog; log: string[] } {
  const log: string[] = [];
  const find = (name: string): Entry | undefined => entries.find((e) => e.name === name);
  const store = {
    kind: { name: "extensions" },
    repo: "repo",
    local: async () => entries.map((e) => ({ ...e })),
    list: async () => entries.map((e) => ({ ...e })),
    install: async (name: string) => {
      log.push(`install ${name}`);
      const e = find(name)!;
      e.installed = true;
      e.enabled = true;
      return { ok: true, note: `${name} installed` };
    },
    enable: async (name: string, on: boolean) => {
      log.push(`${on ? "on" : "off"} ${name}`);
      find(name)!.enabled = on;
      return { ok: true, note: `${name} ${on ? "on" : "off"}` };
    },
    remove: async () => ({ ok: true, note: "" }),
  } as unknown as Catalog;
  return { store, log };
}

function host(ext: Catalog, skills: Catalog): { host: CommandHost; applied: string[]; thinking: string[] } {
  const applied: string[] = [];
  const thinking: string[] = [];
  const agent = new Agent({ provider: {} as Provider, model: "m", system: "", tools: [], maxTurns: 1, maxCost: 1 });
  return {
    host: {
      agent,
      catalogs: { extensions: ext, skills },
      apply: async (kind, name, change) => (applied.push(`${kind} ${change} ${name}`), "done"),
      thinking: { current: () => thinking.at(-1), set: (name) => (thinking.push(name), `thinking ${name}`) },
    },
    applied,
    thinking,
  };
}

describe("profiles", () => {
  test("six built in, with mushroom names; the user's file changes one and adds another", async () => {
    expect(PROFILES.map((p) => p.title)).toEqual(["Amanita Muscaria", "Shiitake", "Psilocybe", "Morchella", "Cordyceps", "Mycena"]);
    writeFileSync(join(home, ".kinoko", "profiles.json"), JSON.stringify({ profiles: [{ name: "mycena", thinking: "off" }, { name: "enoki", title: "Enoki", extensions: ["web"], skills: [] }, { title: "nameless" }] }));
    const all = await readProfiles(home);
    expect(all.find((p) => p.name === "mycena")).toMatchObject({ title: "Mycena", thinking: "off", extensions: ["permission-gate", "check-early"] });
    expect(all.find((p) => p.name === "enoki")).toMatchObject({ title: "Enoki", extensions: ["web"] });
    expect(all.length).toBe(7);
    rmSync(join(home, ".kinoko", "profiles.json"));
  });

  test("applying one installs what it lists, switches the rest off, sets thinking and approvals, and is remembered", async () => {
    const ext = catalog([
      { name: "web", description: "", installed: false },
      { name: "github", description: "", installed: true, enabled: false },
      { name: "cliamp", description: "", installed: true, enabled: true },
      { name: "check-early", description: "", installed: true, enabled: true },
    ]);
    const skills = catalog([
      { name: "omarchy", description: "", installed: true, enabled: true, shared: true },
      { name: "write-kinoko-extension", description: "", installed: false },
    ]);
    const h = host(ext.store, skills.store);
    const profile: Profile = { name: "t", title: "Test", description: "", extensions: ["web", "github", "check-early", "nowhere"], skills: ["write-kinoko-extension"], thinking: "medium" };
    const note = await applyProfile(h.host, home, profile, AbortSignal.timeout(5000));
    expect(ext.log).toEqual(["install web", "on github", "off cliamp"]);
    expect(skills.log).toEqual(["off omarchy", "install write-kinoko-extension"]);
    expect(h.applied).toEqual(["extensions install web", "extensions enable github", "extensions disable cliamp", "skills disable omarchy", "skills install write-kinoko-extension"]);
    expect(h.thinking).toEqual(["medium"]);
    expect(h.host.agent.autoApprove).toBe(false);
    expect(note).toBe("Test: 2 installed, 1 on, 2 off; thinking medium; not found: nowhere");
    expect(await currentProfile(home)).toBe("t");
  });

  test("Amanita: everything in the catalogs on but plan-mode, nothing asked", async () => {
    const ext = catalog([
      { name: "web", description: "", installed: false },
      { name: "plan-mode", description: "", installed: true, enabled: true },
    ]);
    const skills = catalog([{ name: "ffmpeg", description: "", installed: true, enabled: false, shared: true }]);
    const h = host(ext.store, skills.store);
    const note = await applyProfile(h.host, home, PROFILES[0]!, AbortSignal.timeout(5000));
    expect(ext.log).toEqual(["install web", "off plan-mode"]);
    expect(skills.log).toEqual(["on ffmpeg"]);
    expect(h.host.agent.autoApprove).toBe(true);
    expect(note).toBe("Amanita Muscaria: 1 installed, 1 on, 1 off; thinking high; nothing asked");
    expect((await activeProfile(home))?.title).toBe("Amanita Muscaria");
  });

  test("the phone's /profile: the list with the one in use, then a switch by name", async () => {
    const ext = catalog([{ name: "web", description: "", installed: true, enabled: true }]);
    const h = host(ext.store, catalog([]).store);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const listed = await runCommand(h.host, "profile", "", AbortSignal.timeout(5000));
      expect(listed.items?.map((i) => i.name)).toEqual(PROFILES.map((p) => p.name));
      const switched = await runCommand(h.host, "profile", "Morchella", AbortSignal.timeout(5000));
      expect(switched.text).toStartWith("Morchella: ");
      expect(switched.items?.find((i) => i.current)?.name).toBe("morchella");
      expect((await runCommand(h.host, "profile", "nope", AbortSignal.timeout(5000))).text).toBe("no profile nope");
    } finally {
      process.env.HOME = saved;
    }
  });
});
