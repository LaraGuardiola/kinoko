// Tailscale, so the phone reaches `kinoko serve` from anywhere: `tailscale serve` shares it with
// your tailnet only (the phone runs Tailscale: encrypted end to end, nobody else sees it), and
// `tailscale funnel` opens it to the internet for devices without Tailscale (then only the paired
// device tokens stand guard). Either way it is HTTPS with a real certificate, on the machine's
// *.ts.net name; kinoko itself listens on localhost only.

export type Run = (cmd: string[], signal: AbortSignal) => Promise<{ code: number; out: string }>;

export const runCommand: Run = async (cmd, signal) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: code === 0 ? out : `${err}${out}`.trim() };
  } catch {
    return { code: 127, out: `${cmd[0]} is not installed` };
  }
};

export interface Tailnet {
  /** This machine's name in the tailnet: omarchy.tail1234.ts.net */
  dns: string;
  /** Other devices of the tailnet, with whether they are online (the phone, say). */
  peers: Array<{ name: string; os: string; online: boolean }>;
}

/** The tailnet as this machine sees it, or why there is none. */
export async function tailnet(signal: AbortSignal, run: Run = runCommand): Promise<Tailnet | string> {
  const res = await run(["tailscale", "status", "--json"], signal);
  if (res.code === 127) return "Tailscale is not installed (https://tailscale.com/download)";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.out) as Record<string, unknown>;
  } catch {
    return `tailscale status failed: ${res.out.split("\n")[0] ?? ""}`;
  }
  if (data.BackendState !== "Running") return `Tailscale is ${String(data.BackendState ?? "not running").toLowerCase()}: run \`tailscale up\``;
  const self = (data.Self ?? {}) as Record<string, unknown>;
  const dns = String(self.DNSName ?? "").replace(/\.$/, "");
  if (dns === "") return "Tailscale has no DNS name for this machine (MagicDNS off?)";
  const peers = Object.values((data.Peer ?? {}) as Record<string, Record<string, unknown>>).map((p) => ({
    name: String(p.HostName ?? p.DNSName ?? "?"),
    os: String(p.OS ?? ""),
    online: p.Online === true,
  }));
  return { dns, peers };
}

/** What to do about a failed serve or funnel, in words. */
function hint(out: string, funnel: boolean): string {
  if (/access denied|permission|operator/i.test(out)) return `${out}\n  → once: sudo tailscale set --operator=$USER`;
  if (/https|cert/i.test(out) && /enable|disabled|not enabled/i.test(out)) return `${out}\n  → enable HTTPS certificates: https://login.tailscale.com/admin/dns`;
  if (funnel && /funnel/i.test(out) && /not|attr|policy|enable/i.test(out)) return `${out}\n  → allow Funnel for this machine: https://login.tailscale.com/admin/acls (nodeAttrs "funnel")`;
  return out;
}

/** Shares http://127.0.0.1:<port> on https://<dns>:<publicPort>, with the tailnet or (funnel) the
 *  internet. Returns the URL, or an Error saying why not. */
export async function expose(opts: { port: number; publicPort: number; funnel: boolean; dns: string }, signal: AbortSignal, run: Run = runCommand): Promise<string | Error> {
  const res = await run(["tailscale", opts.funnel ? "funnel" : "serve", "--bg", "--yes", `--https=${opts.publicPort}`, `http://127.0.0.1:${opts.port}`], signal);
  if (res.code !== 0) return new Error(hint(res.out || "tailscale refused", opts.funnel));
  return `https://${opts.dns}${opts.publicPort === 443 ? "" : `:${opts.publicPort}`}`;
}

/** Takes the share down again (on exit). */
export async function unexpose(opts: { publicPort: number; funnel: boolean }, signal: AbortSignal, run: Run = runCommand): Promise<void> {
  await run(["tailscale", opts.funnel ? "funnel" : "serve", "--yes", `--https=${opts.publicPort}`, "off"], signal);
}
