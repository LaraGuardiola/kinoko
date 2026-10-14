import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadSavedModels, removeModel, saveModel, setDefaultModel } from "../../config.ts";
import { endpointOf, hostOf, modelsPage } from "../../tui/models-menu.ts";
import type { ModelChoice } from "../../tui/models-menu.ts";

const HOME = `${process.cwd()}/.tmp-models-test-${process.pid}`;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("models page", () => {
  test("an endpoint as typed: a scheme when it has none, no trailing slash", () => {
    expect(endpointOf(" 127.0.0.1:8080/v1/ ")).toBe("http://127.0.0.1:8080/v1");
    expect(endpointOf("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(endpointOf("  ")).toBeUndefined();
    expect(hostOf("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
  });

  test("grouped by provider, in name order: a header, its models, then add; the one in use marked", () => {
    const picked: ModelChoice[] = [];
    const page = modelsPage(
      {
        model: "qwen",
        endpoint: "http://local:8081/v1",
        served: new Map([
          ["http://local:8081/v1", [{ id: "qwen" }]],
          ["http://box:8085/v1", [{ id: "/models/vision-Q4_K_M.gguf", contextWindow: 65536 }, { id: "small" }]],
        ]),
        loading: false,
        saved: [
          { model: "qwen", baseUrl: "http://local:8081/v1", apiKey: "", label: "strata" }, // also served: listed once
          { model: "/models/vision-Q4_K_M.gguf", baseUrl: "http://box:8085/v1", apiKey: "k", label: "llama.cpp", contextWindow: 4096 },
          { model: "old", baseUrl: "http://box:8085/v1", apiKey: "k" }, // saved, no longer served: still offered
        ],
        canAdd: true,
      },
      (choice) => picked.push(choice),
    );
    expect(page.title).toBe("Models");
    expect(page.items.map((i) => [i.name, i.description, i.header ?? false, i.current ?? false])).toEqual([
      ["llama.cpp", "box:8085", true, false],
      ["  vision-Q4_K_M", "", false, false],
      ["  small", "", false, false],
      ["  old", "", false, false],
      ["strata", "local:8081", true, false],
      ["  qwen", "in use", false, true],
      ["+ add provider", "An engine or API that serves models (OpenAI-compatible)", false, false],
    ]);
    page.pick(page.items[1]!);
    page.pick(page.items[2]!);
    page.pick(page.items[6]!);
    expect(picked).toEqual([
      // A saved model keeps its own entry (and window)...
      { kind: "use", entry: { model: "/models/vision-Q4_K_M.gguf", baseUrl: "http://box:8085/v1", apiKey: "k", label: "llama.cpp", contextWindow: 4096 } },
      // ...one only served takes the provider's key and name, never another model's window.
      { kind: "use", entry: { model: "small", baseUrl: "http://box:8085/v1", apiKey: "k", label: "llama.cpp" } },
      { kind: "add" },
    ]);
  });

  test("a provider without a name shows its host; still asking says so in the title", () => {
    const page = modelsPage(
      { model: "m", endpoint: "http://a:1/v1", served: new Map(), loading: true, saved: [{ model: "m", baseUrl: "http://a:1/v1", apiKey: "" }], canAdd: false },
      () => undefined,
    );
    expect(page.title).toBe("Models (asking the providers…)");
    expect(page.items.map((i) => [i.name, i.description])).toEqual([
      ["a:1", ""],
      ["  m", "in use"],
    ]);
  });
});

describe("saved models", () => {
  test("saving replaces the same endpoint and model; the file holds keys, so only its owner reads it", async () => {
    await saveModel({ model: "a", baseUrl: "http://x/v1", apiKey: "k1" }, HOME);
    await saveModel({ model: "b", baseUrl: "http://x/v1", apiKey: "k1" }, HOME);
    const all = await saveModel({ model: "a", baseUrl: "http://x/v1", apiKey: "k2", contextWindow: 9000 }, HOME);
    expect(all.map((m) => [m.model, m.apiKey])).toEqual([["b", "k1"], ["a", "k2"]]);
    expect(await loadSavedModels(HOME)).toEqual(all);
    if (process.platform !== "win32") expect(statSync(`${HOME}/.kinoko/models.json`).mode & 0o777).toBe(0o600); // no Unix modes on Windows
    expect(await loadSavedModels(`${HOME}/nowhere`)).toEqual([]);
    // Removing takes out only that endpoint's model.
    expect((await removeModel({ model: "a", baseUrl: "http://x/v1", apiKey: "" }, HOME)).map((m) => m.model)).toEqual(["b"]);
  });

  test("saved models can be removed, the configured one cannot; the page says how", () => {
    const configured = { model: "qwen", baseUrl: "http://local:8081/v1", apiKey: "" };
    const added = { model: "llama", baseUrl: "http://box:8080/v1", apiKey: "" };
    const page = modelsPage(
      { model: "qwen", endpoint: "http://local:8081/v1", served: new Map(), loading: false, saved: [configured, added], canAdd: true, fixed: (e) => e === configured },
      () => undefined,
    );
    expect(page.items.filter((i) => !i.header).map((i) => [i.name, i.removable ?? false])).toEqual([
      ["  llama", true],
      ["  qwen", false],
      ["+ add provider", false],
    ]);
    expect(page.hint).toBe("Enter to use · Del twice to remove a saved model");
  });

  test("the default is marked; D makes the selected one the default", () => {
    const configured = { model: "qwen", baseUrl: "http://local:8081/v1", apiKey: "" };
    const added = { model: "llama", baseUrl: "http://box:8080/v1", apiKey: "" };
    const chosen: ModelChoice[] = [];
    const page = modelsPage(
      { model: "llama", endpoint: "http://box:8080/v1", served: new Map(), loading: false, saved: [configured, added], canAdd: true, fixed: (e) => e === configured, canDefault: true },
      (c) => chosen.push(c),
    );
    expect(page.items.filter((i) => !i.header).map((i) => [i.name, i.description])).toEqual([
      ["  llama", "in use"],
      ["  qwen", "default"],
      ["+ add provider", "An engine or API that serves models (OpenAI-compatible)"],
    ]);
    expect(page.hint).toBe("Enter to use · D: the default for new sessions · Del twice to remove a saved model");
    page.keys?.d?.(page.items.find((i) => i.name === "  llama")!);
    page.keys?.d?.(page.items.find((i) => i.name === "+ add provider")!); // not a model: nothing
    expect(chosen).toEqual([{ kind: "default", entry: added }]);
  });

  test("the default goes into config.json: the rest of the file kept, the old model's window and label gone", async () => {
    await mkdir(`${HOME}/.kinoko`, { recursive: true });
    await Bun.write(`${HOME}/.kinoko/config.json`, JSON.stringify({ model: "old", baseUrl: "http://a/v1", apiKey: "k", contextWindow: 131072, label: "strata", maxTurns: 9 }));
    await setDefaultModel({ model: "new", baseUrl: "http://b/v1", apiKey: "" }, HOME);
    expect(await Bun.file(`${HOME}/.kinoko/config.json`).json()).toEqual({ model: "new", baseUrl: "http://b/v1", apiKey: "", maxTurns: 9 });
    if (process.platform !== "win32") expect(statSync(`${HOME}/.kinoko/config.json`).mode & 0o777).toBe(0o600);
    await setDefaultModel({ model: "x", baseUrl: "http://c/v1", apiKey: "", contextWindow: 8000, provider: "anthropic" }, `${HOME}/fresh`);
    expect(await Bun.file(`${HOME}/fresh/.kinoko/config.json`).json()).toEqual({ model: "x", baseUrl: "http://c/v1", apiKey: "", provider: "anthropic", contextWindow: 8000 });
  });
});
