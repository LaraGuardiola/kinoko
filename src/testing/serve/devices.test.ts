import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Devices } from "../../serve/devices.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("serve: devices", () => {
  test("a pairing code works once, gives a token that checks; the file keeps hashes, mode 600", async () => {
    const file = join(dir, "a.json");
    const devices = new Devices(file);
    const code = await devices.code();
    const paired = await devices.pair(code, "OnePlus 12R");
    expect(paired?.device.name).toBe("OnePlus 12R");
    expect(await devices.pair(code, "again")).toBeUndefined();
    expect((await devices.check(paired?.token ?? ""))?.id).toBe(paired?.device.id);
    expect(await devices.check("nope")).toBeUndefined();
    expect(await devices.check("")).toBeUndefined();
    const text = await Bun.file(file).text();
    expect(text).not.toContain(paired?.token ?? "?");
    expect(text).not.toContain(code);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // no Unix modes on Windows
  });

  test("a code expires after ten minutes", async () => {
    let clock = 0;
    const devices = new Devices(join(dir, "b.json"), () => clock);
    const code = await devices.code();
    clock = 11 * 60_000;
    expect(await devices.pair(code, "late")).toBeUndefined();
  });

  test("revoked by id or name, the token no longer checks; another process sees it at once", async () => {
    const file = join(dir, "c.json");
    const a = new Devices(file);
    const paired = await a.pair(await a.code(), "tablet");
    const b = new Devices(file); // `kinoko serve revoke` in another process
    expect(await b.revoke("tablet")).toBe(true);
    expect(await a.check(paired?.token ?? "")).toBeUndefined();
    expect(await b.revoke("tablet")).toBe(false);
  });

  test("changes at the same time all land: two pairings and the checks of two tokens", async () => {
    const devices = new Devices(join(dir, "d.json"));
    const [one, two] = await Promise.all([devices.code(), devices.code()]);
    const paired = await Promise.all([devices.pair(one, "phone"), devices.pair(two, "tablet")]);
    expect((await devices.list()).map((d) => d.name).toSorted()).toEqual(["phone", "tablet"]);
    const seen = await Promise.all(paired.map((p) => devices.check(p?.token ?? "")));
    expect(seen.map((d) => d?.name)).toEqual(["phone", "tablet"]);
  });
});
