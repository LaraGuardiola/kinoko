import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationsFile, readIntegrations, setTelegram } from "../integrations.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-integrations-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("integrations.json", () => {
  test("none yet: nothing set up; saved: mode 600, options on by default; forgotten again", async () => {
    expect(await readIntegrations(home)).toEqual({});
    await setTelegram(home, () => ({ token: "1:t", bot: "b", notify: true, prompts: true, approvals: true, on: true }));
    expect(statSync(integrationsFile(home)).mode & 0o777).toBe(0o600);
    await setTelegram(home, (t) => (t ? { ...t, chat: 5, name: "Lara", notify: false } : t));
    expect((await readIntegrations(home)).telegram).toEqual({ token: "1:t", bot: "b", chat: 5, name: "Lara", notify: false, prompts: true, approvals: true, on: true });
    await setTelegram(home, () => undefined);
    expect(await readIntegrations(home)).toEqual({});
  });

  test("a broken file or one without a token counts as not set up; missing switches are on", async () => {
    mkdirSync(join(home, ".kinoko"), { recursive: true });
    writeFileSync(integrationsFile(home), "{ not json");
    expect(await readIntegrations(home)).toEqual({});
    writeFileSync(integrationsFile(home), JSON.stringify({ telegram: { bot: "b" } }));
    expect(await readIntegrations(home)).toEqual({});
    writeFileSync(integrationsFile(home), JSON.stringify({ telegram: { token: "1:t" } }));
    expect((await readIntegrations(home)).telegram).toMatchObject({ bot: "", notify: true, prompts: true, approvals: true, on: true });
  });
});
