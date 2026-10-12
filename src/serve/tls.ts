// The hub's own certificate, for the local network: no Tailscale there, so the hub encrypts itself.
// Self-signed (nobody else could vouch for 192.168.1.42); the app trusts it by its fingerprint,
// which the pairing QR carries. Built here with node:crypto: an EC key and a minimal X.509 v3
// certificate, DER by hand (no openssl, nothing downloaded). Kept in ~/.kinoko/tls (0700/0600).

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

export interface Identity {
  cert: string;
  key: string;
  /** SHA-256 of the certificate (DER), base64url: what the app pins. */
  fingerprint: string;
}

// ---- DER, just what a certificate needs ----

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.from([tag, ...length(body.length)]), body]);
}

const seq = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, ...parts);
const ECDSA_SHA256 = Uint8Array.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const COMMON_NAME = Uint8Array.from([0x06, 0x03, 0x55, 0x04, 0x03]);

/** UTCTime, YYMMDDHHMMSSZ (good until 2049). */
function utcTime(date: Date): Uint8Array {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

function name(cn: string): Uint8Array {
  return seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, Buffer.from(cn, "utf8")))));
}

/** A new key and a self-signed certificate for it, valid from yesterday for twenty years. */
export function selfSigned(cn: string, now = new Date()): { cert: string; key: string; der: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01; // positive, and not zero
  const from = new Date(now.getTime() - 86_400_000);
  const until = new Date(now.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + 20);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Uint8Array.from([2]))), // v3
    tlv(0x02, serial),
    seq(ECDSA_SHA256),
    name(cn),
    seq(utcTime(from), utcTime(until)),
    name(cn),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey); // DER (r, s) for an EC key
  const der = seq(tbs, seq(ECDSA_SHA256), tlv(0x03, Uint8Array.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), der };
}

/** SHA-256 of a certificate's DER, base64url. */
export function fingerprintOf(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("base64url");
}

function derOf(pem: string): Uint8Array {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

/** The hub's identity: made once, then the same (the paired apps pin its fingerprint). */
export async function identity(dir: string): Promise<Identity> {
  const certFile = Bun.file(join(dir, "cert.pem"));
  const keyFile = Bun.file(join(dir, "key.pem"));
  if ((await certFile.exists()) && (await keyFile.exists())) {
    const cert = await certFile.text();
    return { cert, key: await keyFile.text(), fingerprint: fingerprintOf(derOf(cert)) };
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const made = selfSigned("kinoko");
  await Bun.write(keyFile, made.key);
  await chmod(join(dir, "key.pem"), 0o600);
  await Bun.write(certFile, made.cert);
  await chmod(join(dir, "cert.pem"), 0o600);
  return { cert: made.cert, key: made.key, fingerprint: fingerprintOf(made.der) };
}

/** Not the local network: containers, VMs, VPNs (Tailscale has its own address). */
const VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|tailscale|tun|tap|wg|zt)/;

/** This computer's addresses on the local network (private IPv4), the Wi-Fi or cable first. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [nic, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL.test(nic)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return out;
}
