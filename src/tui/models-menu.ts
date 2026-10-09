// The models page, grouped by provider, and the "add provider" steps: its name, endpoint, API key,
// then a model it serves (or its id typed by hand when the endpoint cannot list them).

import type { SavedModel } from "../config.ts";
import { modelName } from "../prompt.ts";
import type { Served } from "../providers/openai-compat.ts";
import type { InputPage, ListPage, MenuItem } from "./menu.ts";

export type ModelChoice =
  | { kind: "use"; entry: SavedModel }
  | { kind: "add" }
  | { kind: "remove"; entry: SavedModel };

export interface ModelsView {
  model: string;
  endpoint: string;
  /** What each endpoint serves, by base URL; an endpoint not (yet) answered is absent. */
  served: Map<string, Served[]>;
  /** Some endpoints are still being asked. */
  loading: boolean;
  saved: SavedModel[];
  /** Offer "+ add provider" (there is somewhere to save it). */
  canAdd: boolean;
  /** Entries that cannot be removed here (the configured model: it lives in config.json). */
  fixed?: (entry: SavedModel) => boolean;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The endpoint as typed, made usable: a scheme when it has none, no trailing slash. */
export function endpointOf(typed: string): string | undefined {
  const text = typed.trim().replace(/\/+$/, "");
  if (text === "") return undefined;
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

/** A provider's name: the one given when it was added, else its host. */
export function providerLabel(baseUrl: string, saved: SavedModel[]): string {
  return saved.find((m) => m.baseUrl === baseUrl && m.label)?.label ?? (baseUrl === "" ? "engine" : hostOf(baseUrl));
}

/**
 * The models grouped by provider (one per endpoint), providers in name order: a header, then what
 * the endpoint serves, then saved models it did not list. "+ add provider" last.
 */
export function modelsPage(view: ModelsView, choose: (choice: ModelChoice) => void): ListPage {
  const choices = new Map<string, ModelChoice>();
  const items: MenuItem[] = [];
  const endpoints = [...new Set([view.endpoint, ...view.saved.map((m) => m.baseUrl), ...view.served.keys()])];
  const groups = endpoints
    .map((baseUrl) => ({ baseUrl, label: providerLabel(baseUrl, view.saved) }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
  for (const { baseUrl, label } of groups) {
    const entries = view.saved.filter((m) => m.baseUrl === baseUrl);
    // The provider's key and wire protocol, for its models that were never saved on their own.
    const { contextWindow: _theirs, ...base } = entries[0] ?? { model: "", baseUrl, apiKey: "" };
    const rows: Array<{ entry: SavedModel; saved: boolean }> = [];
    for (const s of view.served.get(baseUrl) ?? []) {
      const known = entries.find((m) => m.model === s.id);
      const window = s.contextWindow ? { contextWindow: s.contextWindow } : {};
      rows.push({ entry: known ?? { ...base, model: s.id, ...window }, saved: known !== undefined });
    }
    for (const entry of entries) {
      if (!rows.some((r) => r.entry.model === entry.model)) rows.push({ entry, saved: true });
    }
    if (rows.length === 0) continue;
    const host = baseUrl === "" ? "" : hostOf(baseUrl);
    items.push({ name: label, description: host === label ? "" : host, header: true, key: `header:${baseUrl}` });
    for (const { entry, saved } of rows) {
      const key = `${baseUrl}\u0000${entry.model}`;
      choices.set(key, { kind: "use", entry });
      const current = baseUrl === view.endpoint && entry.model === view.model;
      const removable = saved && view.canAdd && !(view.fixed?.(entry) ?? false);
      items.push({ name: `  ${modelName(entry.model)}`, description: current ? "in use" : "", current, key, removable });
    }
  }
  if (view.canAdd) {
    choices.set("add", { kind: "add" });
    items.push({ name: "+ add provider", description: "An engine or API that serves models (OpenAI-compatible)", key: "add" });
  }
  return {
    kind: "list",
    title: view.loading ? "Models (asking the providers…)" : "Models",
    items,
    empty: "no models yet",
    pick: (item) => {
      const choice = item.key === undefined ? undefined : choices.get(item.key);
      if (choice) choose(choice);
    },
    remove: (item) => {
      const choice = item.key === undefined ? undefined : choices.get(item.key);
      if (choice?.kind === "use" && item.removable) choose({ kind: "remove", entry: choice.entry });
    },
    hint: items.some((item) => item.removable) ? "Enter to use · Del twice to remove a saved model" : undefined,
  };
}

const STEPS = "Enter to continue · Esc to go back";

export function labelPage(submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: "Add provider · 1/4",
    label: "Name",
    hint: `What to call it in this list, e.g. strata, llama.cpp, openrouter · ${STEPS}`,
    submit,
  };
}

export function endpointPage(submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: "Add provider · 2/4",
    label: "Endpoint",
    hint: `The address that serves /chat/completions, e.g. http://127.0.0.1:8080/v1 · ${STEPS}`,
    submit,
  };
}

export function keyPage(submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: "Add provider · 3/4",
    label: "API key",
    hint: `Leave it empty when the endpoint needs none · ${STEPS}`,
    secret: true,
    submit,
  };
}

/** The endpoint's own list to pick from; undefined while it is being asked. */
export function servedPage(host: string, served: Served[] | undefined, choose: (model: Served) => void): ListPage {
  return {
    kind: "list",
    title: `Add provider · 4/4 · ${host}`,
    items: (served ?? []).map((s) => ({
      name: modelName(s.id),
      key: s.id,
      description: s.contextWindow ? `${s.contextWindow.toLocaleString("en-US")} tokens of context` : "",
    })),
    empty: "asking the endpoint which models it serves…",
    pick: (item) => {
      const model = served?.find((s) => s.id === item.key);
      if (model) choose(model);
    },
  };
}

/** The model id typed by hand. `reachable` false: nothing answered, which is worth saying first. */
export function namePage(host: string, reachable: boolean, submit: (text: string) => void): InputPage {
  const why = reachable
    ? "The endpoint did not list its models: type the model id"
    : `Nothing answered at ${host}: is its server running? Esc to go back, or type the model id anyway`;
  return { kind: "input", title: `Add provider · 4/4 · ${host}`, label: "Model", hint: `${why} · ${STEPS}`, submit };
}
