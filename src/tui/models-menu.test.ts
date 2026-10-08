import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { loadSavedModels, removeModel, saveModel } from "../config.ts";
import { endpointOf, hostOf, modelsPage } from "./models-menu.ts";
import type { ModelChoice } from "./models-menu.ts";

const HOME = `${process.cwd()}/.tmp-models-test-${process.pid}`;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("models page", () => {
  test("an endpoint as typed: a scheme when it has none, no trailing slash", () => {
    expect(endpointOf(" 127.0.0.1:8080/v1/ ")).toBe("http://127.0.0.1:8080/v1");
    expect(endpointOf("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(endpointOf("  ")).toBeUndefined();
    expect(hostOf("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
  });

  test("served models, then saved ones from elsewhere by host, then add; the one in use marked", () => {
    const picked: ModelChoice[] = [];
    const page = modelsPage(
      {
        model: "qwen",
        endpoint: "http://local:8081/v1",
        served: ["qwen"],
        saved: [
          { model: "qwen", baseUrl: "http://local:8081/v1", apiKey: "" }, // the same as served: once
          { model: "llama", baseUrl: "http://box:8080/v1", apiKey: "k" },
        ],
        canAdd: true,
      },
      (choice) => picked.push(choice),
    );
    expect(page.items.map((i) => [i.name, i.description, i.current ?? false])).toEqual([
      ["qwen", "in use", true],
      ["llama", "box:8080", false],
      ["+ add model", "A model served by another endpoint (OpenAI-compatible)", false],
    ]);
    page.pick(page.items[1]!);
    page.pick(page.items[2]!);
    expect(picked).toEqual([{ kind: "saved", entry: { model: "llama", baseUrl: "http://box:8080/v1", apiKey: "k" } }, { kind: "add" }]);
  });
});

describe("saved models", () => {
  test("saving replaces the same endpoint and model; the file holds keys, so only its owner reads it", async () => {
    await saveModel({ model: "a", baseUrl: "http://x/v1", apiKey: "k1" }, HOME);
    await saveModel({ model: "b", baseUrl: "http://x/v1", apiKey: "k1" }, HOME);
    const all = await saveModel({ model: "a", baseUrl: "http://x/v1", apiKey: "k2", contextWindow: 9000 }, HOME);
    expect(all.map((m) => [m.model, m.apiKey])).toEqual([["b", "k1"], ["a", "k2"]]);
    expect(await loadSavedModels(HOME)).toEqual(all);
    expect(statSync(`${HOME}/.kinoko/models.json`).mode & 0o777).toBe(0o600);
    expect(await loadSavedModels(`${HOME}/nowhere`)).toEqual([]);
    // Removing takes out only that endpoint's model.
    expect((await removeModel({ model: "a", baseUrl: "http://x/v1", apiKey: "" }, HOME)).map((m) => m.model)).toEqual(["b"]);
  });

  test("saved models can be removed, the configured one cannot; the page says how", () => {
    const configured = { model: "qwen", baseUrl: "http://local:8081/v1", apiKey: "" };
    const added = { model: "llama", baseUrl: "http://box:8080/v1", apiKey: "" };
    const page = modelsPage(
      { model: "qwen", endpoint: "http://local:8081/v1", served: [], saved: [configured, added], canAdd: true, fixed: (e) => e === configured },
      () => undefined,
    );
    expect(page.items.map((i) => [i.name, i.removable ?? false])).toEqual([["qwen", false], ["llama", true], ["+ add model", false]]);
    expect(page.hint).toBe("Enter to use · Del twice to remove a saved model");
  });
});
