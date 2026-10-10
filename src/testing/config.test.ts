import { expect, test } from "bun:test";
import { resumeModel, thinkingLabel } from "../config.ts";

test("the thinking label: level, budget when one is set, OFF without one", () => {
  expect(thinkingLabel("low", 2048)).toBe("LOW · 2048");
  expect(thinkingLabel("high", undefined)).toBe("HIGH");
  expect(thinkingLabel(undefined, undefined)).toBe("DEFAULT");
  expect(thinkingLabel("off", 2048)).toBe("OFF");
});

test("a resume starts with the session's last model, with the key of a known entry at its endpoint", () => {
  const configured = { model: "coder", baseUrl: "http://local:8081/v1", apiKey: "k1", contextWindow: 122880 };
  const remote = { model: "qwen", baseUrl: "http://local:8085/v1", apiKey: "k2", contextWindow: 65536, provider: "openai-compat" as const };
  const known = [configured, remote];
  expect(resumeModel(undefined, known)).toBeUndefined(); // never switched: the configured one stands
  expect(resumeModel({ model: "qwen", baseUrl: "http://local:8085/v1" }, known)).toEqual(remote);
  // Another model served at a known endpoint: that endpoint's key, the session's window.
  expect(resumeModel({ model: "beta", baseUrl: "http://local:8081/v1", contextWindow: 4096 }, known)).toEqual({ ...configured, model: "beta", contextWindow: 4096 });
  expect(resumeModel({ model: "beta", baseUrl: "http://local:8081/v1" }, known)).toEqual({ model: "beta", baseUrl: "http://local:8081/v1", apiKey: "k1" });
  expect(resumeModel({ model: "x", baseUrl: "http://gone:9/v1" }, known)).toBeUndefined();
});

test("label names the configured provider; a non-string is dropped; retries is read", async () => {
  const { loadConfig } = await import("../config.ts");
  const dir = `${process.cwd()}/.tmp-config-label-${process.pid}`;
  await Bun.write(`${dir}/.kinoko/config.json`, JSON.stringify({ label: "strata" }));
  const cwd = process.cwd();
  const home = process.env.HOME;
  process.env.HOME = dir; // the real ~/.kinoko/config.json must not leak in
  process.chdir(dir);
  try {
    expect((await loadConfig()).label).toBe("strata");
    await Bun.write(`${dir}/.kinoko/config.json`, JSON.stringify({ label: 7, retries: 5 }));
    expect((await loadConfig()).label).toBeUndefined();
    expect((await loadConfig()).retries).toBe(5); // retries: a number, like the other limits
  } finally {
    process.chdir(cwd);
    process.env.HOME = home;
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  }
});

test("layoutCols: 80 columns inside herdr (its phone views re-wrap the text), the whole terminal elsewhere; maxCols wins", async () => {
  const { layoutCols } = await import("../config.ts");
  expect(layoutCols(180, undefined, {})).toBe(180);
  expect(layoutCols(180, undefined, { TERM_PROGRAM: "herdr" })).toBe(80);
  expect(layoutCols(180, undefined, { HERDR_ENV: "1" })).toBe(80);
  expect(layoutCols(60, undefined, { TERM_PROGRAM: "herdr" })).toBe(60); // narrower than the cap: all of it
  expect(layoutCols(180, 0, { TERM_PROGRAM: "herdr" })).toBe(180); // 0: the whole terminal, herdr or not
  expect(layoutCols(180, 100, {})).toBe(100);
});
