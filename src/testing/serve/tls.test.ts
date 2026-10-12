import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOf, identity, lanAddresses, selfSigned } from "../../serve/tls.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-tls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const nic = (address: string, family = "IPv4", internal = false): object => ({ address, family, internal, netmask: "", mac: "", cidr: null });

describe("the hub's own certificate", () => {
  test("a valid self-signed X.509 v3 certificate for an EC key, good for twenty years", () => {
    const now = new Date("2026-10-12T10:00:00Z");
    const made = selfSigned("kinoko", now);
    const x = new X509Certificate(made.cert);
    expect(x.subject).toBe("CN=kinoko");
    expect(x.issuer).toBe("CN=kinoko");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(new Date(x.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2046);
    expect(fingerprintOf(made.der)).toBe(Buffer.from(x.fingerprint256.replaceAll(":", ""), "hex").toString("base64url"));
  });

  test("made once and kept (the apps pin its fingerprint); the key is the user's alone", async () => {
    const first = await identity(join(dir, "tls"));
    const again = await identity(join(dir, "tls"));
    expect(again).toEqual(first);
    expect(statSync(join(dir, "tls", "key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "tls")).mode & 0o777).toBe(0o700);
  });

  test("the local network's addresses: private IPv4, not containers, VPNs or loopback", () => {
    const found = lanAddresses({
      lo: [nic("127.0.0.1", "IPv4", true)],
      wlo1: [nic("192.168.1.42"), nic("fe80::1", "IPv6")],
      eno1: [nic("10.0.0.7")],
      docker0: [nic("172.17.0.1")],
      tailscale0: [nic("100.91.163.46")],
      enp5: [nic("8.8.8.8")],
    } as never);
    expect(found).toEqual(["192.168.1.42", "10.0.0.7"]);
  });
});
