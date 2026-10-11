import { describe, expect, test } from "bun:test";
import { expose, tailnet, unexpose } from "../../serve/tailscale.ts";
import type { Run } from "../../serve/tailscale.ts";

const signal = new AbortController().signal;

function fake(answer: { code: number; out: string }): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async (cmd) => (calls.push(cmd), answer) };
}

describe("serve: tailscale", () => {
  test("the machine's DNS name and the phones of the tailnet", async () => {
    const status = { BackendState: "Running", Self: { DNSName: "omarchy.tail1.ts.net." }, Peer: { a: { HostName: "OnePlus 12R", OS: "android", Online: true } } };
    expect(await tailnet(signal, fake({ code: 0, out: JSON.stringify(status) }).run)).toEqual({ dns: "omarchy.tail1.ts.net", peers: [{ name: "OnePlus 12R", os: "android", online: true }] });
  });

  test("not installed, stopped, or broken: says why", async () => {
    expect(await tailnet(signal, fake({ code: 127, out: "" }).run)).toStartWith("Tailscale is not installed");
    expect(await tailnet(signal, fake({ code: 0, out: JSON.stringify({ BackendState: "Stopped" }) }).run)).toBe("Tailscale is stopped: run `tailscale up`");
    expect(await tailnet(signal, fake({ code: 1, out: "boom" }).run)).toStartWith("tailscale status failed");
  });

  test("shared with the tailnet, or through Funnel, on its own port; taken down on exit", async () => {
    const serve = fake({ code: 0, out: "" });
    expect(await expose({ port: 7878, publicPort: 8443, funnel: false, dns: "m.ts.net" }, signal, serve.run)).toBe("https://m.ts.net:8443");
    expect(serve.calls[0]).toEqual(["tailscale", "serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:7878"]);
    const funnel = fake({ code: 0, out: "" });
    expect(await expose({ port: 7878, publicPort: 443, funnel: true, dns: "m.ts.net" }, signal, funnel.run)).toBe("https://m.ts.net");
    expect(funnel.calls[0]?.[1]).toBe("funnel");
    await unexpose({ publicPort: 8443, funnel: false }, signal, serve.run);
    expect(serve.calls[1]).toEqual(["tailscale", "serve", "--yes", "--https=8443", "off"]);
  });

  test("a refusal comes back with what to do about it", async () => {
    const denied = await expose({ port: 1, publicPort: 8443, funnel: false, dns: "m" }, signal, fake({ code: 1, out: "Access denied: serve config denied" }).run);
    expect(denied instanceof Error && denied.message).toContain("sudo tailscale set --operator=$USER");
  });
});
