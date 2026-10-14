// `kinoko serve`: the hub the phone app talks to.
//   kinoko serve [--port 7878] [--public-port 8443] [--lan-port 7879] [--funnel | --local | --no-lan | --no-tailscale]
//   kinoko serve pair          a QR code to pair a device (starting the hub when it is not running)
//   kinoko serve lab           links to Kinoko Lab (a live view of the harness), paired once each
//   kinoko serve devices       the paired devices
//   kinoko serve revoke <id>   forget one
// By default it is shared with your tailnet through Tailscale (`--funnel`: with the internet;
// `--local`: not at all) and stops sharing when it stops. On the local network it listens too, on
// --lan-port with its own certificate (the app pins it; `--no-lan` turns that off).

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { renderMarkdown } from "../tui/markdown.ts";
import { Devices } from "./devices.ts";
import { qrText } from "./qr.ts";
import { fenceRenderers } from "./renderers.ts";
import { currentProfile } from "../profiles.ts";
import { identity, lanAddresses } from "./tls.ts";
import { serve } from "./server.ts";
import { Bridge } from "./bridge.ts";
import { projects } from "./projects.ts";
import { expose, tailnet, unexpose } from "./tailscale.ts";
import { userHome } from "../home.ts";
import { hubSocket } from "./link.ts";

const HOME = join(userHome(), ".kinoko");
const STATE = join(HOME, "serve-state.json");
/** Where kinoko TUIs link themselves to the hub (link.ts). */
export const SOCKET = hubSocket(userHome());

interface State {
  pid: number;
  port: number;
  url: string;
  funnel: boolean;
  /** The local network's address and the certificate's fingerprint, when it listens there. */
  lan?: { url: string; fingerprint: string };
}

const time = (): string => new Date().toTimeString().slice(0, 8);
const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

function ago(ms: number | undefined): string {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** The running hub, if there is one: its state file names a live process. */
async function running(): Promise<State | undefined> {
  try {
    const state = (await Bun.file(STATE).json()) as State;
    process.kill(state.pid, 0);
    return state;
  } catch {
    return undefined;
  }
}

async function showPairing(devices: Devices, url: string, lan?: State["lan"]): Promise<void> {
  const code = await devices.code();
  // The local network's address and the certificate's fingerprint ride along: at home the app
  // goes straight there (no Tailscale needed), trusting that certificate only.
  const local = lan ? `&l=${encodeURIComponent(lan.url)}&f=${lan.fingerprint}` : "";
  const link = `kinoko://pair?u=${encodeURIComponent(url)}&c=${code}${local}`;
  out(qrText(link));
  out(`Scan it with the kinoko app (good for 10 minutes, once).`);
  // By hand, the link carries the pin too (a typed address and code could not check the certificate).
  out(dim(lan ? `or paste in the app: ${link}` : `by hand: ${url}  code ${code}`));
  if (url.startsWith("http://127.0.0.1") && !lan) out(dim("this address is this computer only: without Tailscale the phone cannot reach it"));
}

/** Kinoko Lab's links: one for this computer's browser, one (and its QR) for the phone. Each pairs once. */
async function showLab(devices: Devices, state: State): Promise<void> {
  const here = `http://127.0.0.1:${state.port}/lab#c=${await devices.code()}`;
  out(`Kinoko Lab, a live look inside kinoko: open ${bold(here)}`);
  if (!state.url.startsWith("http://127.0.0.1")) {
    const away = `${state.url}/lab#c=${await devices.code()}`;
    out("");
    out(qrText(away));
    out(`On the phone (through Tailscale): scan it, or open ${away}`);
  }
  out(dim("Each link works once, for ten minutes; the browser stays paired (`kinoko serve devices`)."));
}

export async function runServe(argv: string[], opts: { command: string[]; version: string }): Promise<void> {
  const devices = new Devices(join(HOME, "serve.json"));
  const sub = argv[0]?.startsWith("--") ? undefined : argv[0];

  // Not running: `pair` starts it, and shows the code once it is up.
  const pairNow = sub === "pair";
  if (pairNow) {
    const state = await running();
    if (state !== undefined) {
      await showPairing(devices, state.url, state.lan);
      return;
    }
  }
  if (sub === "lab") {
    const state = await running();
    if (state === undefined) {
      out("kinoko serve is not running: start it first (`kinoko serve`), then `kinoko serve lab`.");
      process.exitCode = 1;
      return;
    }
    await showLab(devices, state);
    return;
  }
  if (sub === "devices") {
    const list = await devices.list();
    if (list.length === 0) out("no paired devices: `kinoko serve pair`");
    for (const d of list) out(`${d.id}  ${d.name.padEnd(20)} paired ${ago(d.created)}, seen ${ago(d.seen)}`);
    return;
  }
  if (sub === "revoke") {
    const which = argv[1] ?? "";
    out((await devices.revoke(which)) ? `${which} can no longer connect` : `no device ${which} (see \`kinoko serve devices\`)`);
    return;
  }
  if (sub !== undefined && !pairNow) {
    out(`unknown: kinoko serve ${sub} (pair, lab, devices, revoke)`);
    process.exitCode = 1;
    return;
  }

  if (await running()) {
    out("kinoko serve is already running (`kinoko serve pair` to pair a device).");
    process.exitCode = 1;
    return;
  }
  const port = Number(flag(argv, "port") ?? 7878);
  const publicPort = Number(flag(argv, "public-port") ?? 8443);
  const funnel = argv.includes("--funnel");
  const local = argv.includes("--local");
  const lanPort = Number(flag(argv, "lan-port") ?? 7879);
  // The local network, encrypted (the hub's own certificate): no Tailscale needed at home.
  const lanUrls = local || argv.includes("--no-lan") ? [] : lanAddresses().map((ip) => `https://${ip}:${lanPort}`);
  const lanIdentity = lanUrls.length > 0 ? await identity(join(HOME, "tls")) : undefined;
  // The extensions, loaded only for their renderers (```mermaid…): the phone gets blocks drawn as
  // the TUI draws them, with what is switched on now.
  const renderers = fenceRenderers(userHome());
  await renderers.fresh();
  const render = async (text: string, width: number): Promise<string[]> => {
    await renderers.fresh();
    return renderMarkdown(text, { width }).split("\n");
  };
  // The profile in use, looked at every few seconds (a TUI or the phone may switch it): the phone
  // draws that profile's mushroom.
  let profile = await currentProfile(userHome());
  const hub = serve({ profile: () => profile, port, ...(lanIdentity ? { lan: { port: lanPort, identity: lanIdentity, urls: lanUrls } } : {}), devices, command: opts.command, sessionsDir: join(HOME, "sessions"), version: opts.version, socket: SOCKET, render, log: (line) => out(dim(`${time()} ${line}`)) });

  const profileWatch = setInterval(() => {
    void currentProfile(userHome()).then((now) => {
      if (now === profile) return;
      profile = now;
      hub.announce({ type: "profile", profile: now ?? null });
    });
  }, 3000);
  profileWatch.unref();

  // Telegram (set up from the TUI's /integrations): it answers while the hub runs.
  const bridgeStop = new AbortController();
  const bridge = new Bridge({ home: userHome(), agents: hub.agents, projects: () => projects(join(HOME, "sessions")), log: (line) => out(dim(`${time()} ${line}`)) });
  hub.watch((agent, event) => bridge.event(agent, event));
  void bridge.run(bridgeStop.signal);

  let url = `http://127.0.0.1:${port}`;
  let shared = false;
  const signal = new AbortController().signal;
  out(`${bold("kinoko serve")} 🍄 ${dim(opts.version)}`);
  out(`  local    ${url}`);
  if (!local && !argv.includes("--no-tailscale")) {
    const tn = await tailnet(signal);
    // Said loud: without it, the devices reach this computer from its own network only.
    if (typeof tn === "string") out(`  tailscale \x1b[33moff\x1b[0m: ${tn} ${dim("(until then, devices reach this computer from this network only)")}`);
    else {
      const exposed = await expose({ port, publicPort, funnel, dns: tn.dns }, signal);
      if (exposed instanceof Error) out(`  tailscale \x1b[31mcould not share\x1b[0m: ${exposed.message}`);
      else {
        url = exposed;
        shared = true;
        out(`  ${funnel ? "internet" : "tailnet "} ${bold(url)}  ${dim(funnel ? "(Funnel: anyone can reach it; only paired devices get in)" : "(your tailnet's devices only, from anywhere)")}`);
        const phones = tn.peers.filter((p) => /android|ios/i.test(p.os));
        if (phones.length > 0) out(dim(`           ${phones.map((p) => `${p.name} ${p.online ? "online" : "offline"}`).join(", ")}`));
      }
    }
  }
  const lan = hub.lan && lanIdentity && lanUrls[0] ? { url: lanUrls[0], fingerprint: lanIdentity.fingerprint } : undefined;
  if (lan) out(`  lan      ${bold(lan.url)}  ${dim("(this network, encrypted: no Tailscale needed here)")}`);
  // No tailnet: the local network is the address the app is given first.
  if (lan && !shared) url = lan.url;
  await Bun.write(STATE, JSON.stringify({ pid: process.pid, port, url, funnel, ...(lan ? { lan } : {}) } satisfies State));

  const paired = await devices.list();
  out(`  devices  ${paired.length === 0 ? "none yet" : paired.map((d) => `${d.name} (seen ${ago(d.seen)})`).join(", ")}`);
  out();
  if (paired.length === 0 || pairNow) await showPairing(devices, url, lan);
  else out(`  pair one more: ${bold("kinoko serve pair")} ${dim("(in another terminal) · Ctrl+C stops")}`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    bridgeStop.abort();
    hub.stop();
    if (shared) await unexpose({ publicPort, funnel }, new AbortController().signal);
    await unlink(STATE).catch(() => undefined);
    out(dim("stopped; the share is down"));
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
}
