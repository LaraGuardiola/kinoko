// `kinoko serve`: the hub the phone app talks to.
//   kinoko serve [--port 7878] [--public-port 8443] [--funnel | --local]
//   kinoko serve pair          a QR code to pair a device (the hub must be running)
//   kinoko serve devices       the paired devices
//   kinoko serve revoke <id>   forget one
// By default it is shared with your tailnet through Tailscale (`--funnel`: with the internet;
// `--local`: not at all) and stops sharing when it stops.

import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Devices } from "./devices.ts";
import { qrText } from "./qr.ts";
import { serve } from "./server.ts";
import { expose, tailnet, unexpose } from "./tailscale.ts";

const HOME = join(process.env.HOME ?? homedir(), ".kinoko");
const STATE = join(HOME, "serve-state.json");

interface State {
  pid: number;
  port: number;
  url: string;
  funnel: boolean;
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

async function showPairing(devices: Devices, url: string): Promise<void> {
  const code = await devices.code();
  const link = `kinoko://pair?u=${encodeURIComponent(url)}&c=${code}`;
  out(qrText(link));
  out(`Scan it with the kinoko app (good for 10 minutes, once).`);
  out(dim(`by hand: ${url}  code ${code}`));
  if (url.startsWith("http://127.0.0.1")) out(dim("this address is this computer only: without Tailscale the phone cannot reach it"));
}

export async function runServe(argv: string[], opts: { command: string[]; version: string }): Promise<void> {
  const devices = new Devices(join(HOME, "serve.json"));
  const sub = argv[0]?.startsWith("--") ? undefined : argv[0];

  if (sub === "pair") {
    const state = await running();
    if (state === undefined) {
      out("kinoko serve is not running: start it first (`kinoko serve`), then pair.");
      process.exitCode = 1;
      return;
    }
    await showPairing(devices, state.url);
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
  if (sub !== undefined) {
    out(`unknown: kinoko serve ${sub} (pair, devices, revoke)`);
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
  const hub = serve({ port, devices, command: opts.command, sessionsDir: join(HOME, "sessions"), version: opts.version, log: (line) => out(dim(`${time()} ${line}`)) });

  let url = `http://127.0.0.1:${port}`;
  let shared = false;
  const signal = new AbortController().signal;
  out(`${bold("kinoko serve")} 🍄 ${dim(opts.version)}`);
  out(`  local    ${url}`);
  if (!local) {
    const tn = await tailnet(signal);
    if (typeof tn === "string") out(`  tailscale ${dim(`off: ${tn}`)}`);
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
  await Bun.write(STATE, JSON.stringify({ pid: process.pid, port, url, funnel } satisfies State));

  const paired = await devices.list();
  out(`  devices  ${paired.length === 0 ? "none yet" : paired.map((d) => `${d.name} (seen ${ago(d.seen)})`).join(", ")}`);
  out();
  if (paired.length === 0) await showPairing(devices, url);
  else out(dim("pair another device: kinoko serve pair · Ctrl+C stops"));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
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
