// Paired devices: who may talk to `kinoko serve`. A pairing code (shown as a QR, one use, ten
// minutes) is traded for a device token; only tokens' hashes are kept, in ~/.kinoko/serve.json
// (mode 600), read again on every check so `kinoko serve pair` and `revoke` work while it runs.

import { chmod, rename } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

export interface Device {
  id: string;
  name: string;
  hash: string;
  created: number;
  seen?: number;
}

interface Pending {
  hash: string;
  expires: number;
}

interface Store {
  devices: Device[];
  pairing: Pending[];
}

const PAIRING_MS = 10 * 60_000;

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function same(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** 24 random bytes as base64url: unguessable, and short enough for a QR code. */
function secret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export class Devices {
  #file: string;
  #now: () => number;
  // One read-change-write at a time in this process: two at once shared the temp file (ENOENT)
  // and the later write dropped the earlier one's change (a device just paired, lost).
  #turn: Promise<unknown> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  async #load(): Promise<Store> {
    try {
      const data = (await Bun.file(this.#file).json()) as Partial<Store>;
      return { devices: Array.isArray(data.devices) ? data.devices : [], pairing: Array.isArray(data.pairing) ? data.pairing : [] };
    } catch {
      return { devices: [], pairing: [] };
    }
  }

  /** Runs `op` after the ones before it have finished. */
  #serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(op, op);
    this.#turn = run.catch(() => undefined);
    return run;
  }

  async #save(store: Store): Promise<void> {
    // Written beside and renamed: a crash mid-write never leaves a broken file of tokens.
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(store, null, 2)}\n`);
    await chmod(tmp, 0o600);
    await rename(tmp, this.#file);
  }

  /** A new one-use pairing code, good for ten minutes. */
  code(): Promise<string> {
    return this.#serial(async () => {
      const store = await this.#load();
      const code = secret();
      store.pairing = [...store.pairing.filter((p) => p.expires > this.#now()), { hash: hash(code), expires: this.#now() + PAIRING_MS }];
      await this.#save(store);
      return code;
    });
  }

  /** Trades a pairing code for a device and its token; undefined when the code is wrong, used or old. */
  pair(code: string, name: string): Promise<{ device: Device; token: string } | undefined> {
    return this.#serial(async () => {
      const store = await this.#load();
      const h = hash(code);
      const match = store.pairing.find((p) => p.expires > this.#now() && same(p.hash, h));
      if (match === undefined) return undefined;
      const token = secret() + secret();
      const device: Device = { id: crypto.randomUUID().slice(0, 8), name: name.trim().slice(0, 60) || "device", hash: hash(token), created: this.#now() };
      store.pairing = store.pairing.filter((p) => p !== match && p.expires > this.#now());
      store.devices.push(device);
      await this.#save(store);
      return { device, token };
    });
  }

  /** The device a token belongs to; its last-seen time is kept to the minute. */
  async check(token: string): Promise<Device | undefined> {
    if (token === "") return undefined;
    return this.#serial(async () => {
      const store = await this.#load();
      const h = hash(token);
      const device = store.devices.find((d) => same(d.hash, h));
      if (device !== undefined && this.#now() - (device.seen ?? 0) > 60_000) {
        device.seen = this.#now();
        await this.#save(store);
      }
      return device;
    });
  }

  async list(): Promise<Device[]> {
    return (await this.#load()).devices;
  }

  /** Forgets a device by id or name; false when there is none. */
  revoke(which: string): Promise<boolean> {
    return this.#serial(async () => {
      const store = await this.#load();
      const kept = store.devices.filter((d) => d.id !== which && d.name !== which);
      if (kept.length === store.devices.length) return false;
      store.devices = kept;
      await this.#save(store);
      return true;
    });
  }
}
