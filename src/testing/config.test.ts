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
