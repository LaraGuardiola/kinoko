// Profiles: named sets of what is switched on (extensions, skills), a thinking level and how calls
// that need approval are handled. Applying one installs what it needs from the catalogs, switches
// on what it lists and off the rest, at once. Data, not code: ~/.kinoko/profiles.json changes or
// adds them (same fields; a name already here replaces it). The one in use: ~/.kinoko/profile.json.

import { join } from "node:path";
import type { CommandHost } from "./commands.ts";

export interface Profile {
  name: string;
  title: string;
  description: string;
  /** What it switches on; "*" is everything in the catalog (but `except`). */
  extensions: string[] | "*";
  skills: string[] | "*";
  except?: string[];
  /** A thinking profile's name (off, low, medium, high, extreme). */
  thinking?: string;
  /** "auto": calls an extension asks about run without asking (blocks stay blocks). */
  approvals?: "ask" | "auto";
}

export const PROFILES: Profile[] = [
  {
    name: "amanita",
    title: "Amanita Muscaria",
    description: "Everything on, nothing asked: goes all in (the hardline still blocks)",
    extensions: "*",
    skills: "*",
    except: ["plan-mode"],
    thinking: "high",
    approvals: "auto",
  },
  {
    name: "shiitake",
    title: "Shiitake",
    description: "The coder: checks, GitHub, other agents, diagrams, the web",
    extensions: ["check-early", "github", "delegate", "mermaid", "web", "notify", "permission-gate", "herdr"],
    skills: ["write-kinoko-extension"],
    thinking: "medium",
  },
  {
    name: "psilocybe",
    title: "Psilocybe",
    description: "Media and the desktop: pictures, music on the speaker, video tools, files to the phone",
    extensions: ["vision", "cliamp", "telegram", "web", "notify", "permission-gate", "herdr"],
    skills: ["bluetooth"],
    thinking: "low",
  },
  {
    name: "morchella",
    title: "Morchella",
    description: "The reviewer: reads, plans and explains; writes nothing",
    extensions: ["plan-mode", "github", "web", "mermaid", "vision", "herdr"],
    skills: [],
    thinking: "high",
  },
  {
    name: "cordyceps",
    title: "Cordyceps",
    description: "The orchestrator: hands work to other agents, reports on Telegram",
    extensions: ["delegate", "telegram", "notify", "github", "web", "permission-gate", "herdr"],
    skills: ["write-kinoko-extension"],
    thinking: "medium",
  },
  {
    name: "mycena",
    title: "Mycena",
    description: "Light and fast for a local model: few tools, a short prompt",
    extensions: ["permission-gate", "check-early"],
    skills: [],
    thinking: "low",
  },
];

/** The built-in profiles, with the user's own over them. */
export async function readProfiles(home: string): Promise<Profile[]> {
  const all = new Map(PROFILES.map((p) => [p.name, p]));
  try {
    const data = (await Bun.file(join(home, ".kinoko", "profiles.json")).json()) as { profiles?: Partial<Profile>[] };
    for (const p of data.profiles ?? []) {
      if (typeof p.name !== "string" || !p.name) continue;
      const base = all.get(p.name);
      all.set(p.name, { title: p.name, description: "", extensions: [], skills: [], ...base, ...p } as Profile);
    }
  } catch {
    // none, or not JSON: the built-in ones
  }
  return [...all.values()];
}

export async function currentProfile(home: string): Promise<string | undefined> {
  try {
    const name = ((await Bun.file(join(home, ".kinoko", "profile.json")).json()) as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The profile in use, if one was chosen and still exists. */
export async function activeProfile(home: string): Promise<Profile | undefined> {
  const name = await currentProfile(home);
  return name === undefined ? undefined : (await readProfiles(home)).find((p) => p.name === name);
}

const wants = (list: string[] | "*", except: string[] | undefined, name: string): boolean => (list === "*" ? !(except ?? []).includes(name) : list.includes(name));

/**
 * Applies a profile through the host (the TUI's or an rpc agent's): extensions and skills installed,
 * switched on and off as it says, each taking effect at once; then thinking and approvals. The
 * profile is remembered. A line saying what changed.
 */
export async function applyProfile(host: CommandHost, home: string, profile: Profile, signal: AbortSignal): Promise<string> {
  // Remembered first: what is switched next already shows it as the one in use.
  await Bun.write(join(home, ".kinoko", "profile.json"), `${JSON.stringify({ name: profile.name })}\n`);
  const done = { installed: 0, on: 0, off: 0 };
  const missing: string[] = [];
  for (const kind of ["extensions", "skills"] as const) {
    const store = host.catalogs?.[kind];
    if (store === undefined) continue;
    // oxlint-disable-next-line no-await-in-loop -- one catalog after the other, changes in order
    const entries = await store.list(signal).catch(() => store.local());
    for (const entry of entries) {
      if (entry.here === false) continue; // another system's: passed by, as if the profile did not name it
      const want = wants(profile[kind], profile.except, entry.name);
      const on = entry.installed && entry.enabled !== false;
      if (want === on) continue;
      // oxlint-disable-next-line no-await-in-loop -- installs and switches one at a time
      const outcome = !entry.installed ? (entry.shared ? undefined : await store.install(entry.name, signal)) : await store.enable(entry.name, want);
      if (!outcome?.ok) continue;
      const change = !entry.installed ? "install" : want ? "enable" : "disable";
      // oxlint-disable-next-line no-await-in-loop -- each takes effect before the next
      await host.apply?.(kind, entry.name, change);
      done[change === "install" ? "installed" : change === "enable" ? "on" : "off"]++;
    }
    const names = new Set(entries.map((e) => e.name));
    if (profile[kind] !== "*") for (const name of profile[kind]) if (!names.has(name)) missing.push(name);
  }
  if (profile.thinking) host.thinking?.set(profile.thinking);
  host.agent.setAutoApprove(profile.approvals === "auto");
  const changed = [done.installed && `${done.installed} installed`, done.on && `${done.on} on`, done.off && `${done.off} off`].filter(Boolean).join(", ") || "nothing to switch";
  const extra = [profile.thinking && `thinking ${profile.thinking}`, profile.approvals === "auto" ? "nothing asked" : undefined, missing.length > 0 ? `not found: ${missing.join(", ")}` : undefined].filter(Boolean);
  return `${profile.title}: ${changed}${extra.length > 0 ? `; ${extra.join("; ")}` : ""}`;
}
