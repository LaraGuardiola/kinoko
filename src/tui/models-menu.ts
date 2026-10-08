// The models page and the "add model" steps: endpoint, API key, then a model the endpoint
// serves (or its id typed by hand when the endpoint cannot list them).

import type { SavedModel } from "../config.ts";
import type { Served } from "../providers/openai-compat.ts";
import type { InputPage, ListPage, MenuItem } from "./menu.ts";

export type ModelChoice = { kind: "served"; model: string } | { kind: "saved"; entry: SavedModel } | { kind: "add" };

export interface ModelsView {
  model: string;
  endpoint: string;
  /** What the endpoint in use serves; undefined while it is being asked. */
  served: string[] | undefined;
  saved: SavedModel[];
  /** Offer "+ add model" (there is somewhere to save it). */
  canAdd: boolean;
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

/** Served models first, then saved ones from elsewhere (labelled by host), then "+ add model". */
export function modelsPage(view: ModelsView, choose: (choice: ModelChoice) => void): ListPage {
  const choices = new Map<string, ModelChoice>();
  const items: MenuItem[] = [];
  for (const model of view.served ?? []) {
    choices.set(`served:${model}`, { kind: "served", model });
    items.push({ name: model, description: model === view.model ? "in use" : "", current: model === view.model, key: `served:${model}` });
  }
  for (const [i, entry] of view.saved.entries()) {
    const here = entry.baseUrl === view.endpoint;
    if (here && view.served?.includes(entry.model)) continue; // already listed above
    choices.set(`saved:${i}`, { kind: "saved", entry });
    const current = here && entry.model === view.model;
    items.push({ name: entry.model, description: hostOf(entry.baseUrl), current, key: `saved:${i}` });
  }
  if (view.canAdd) {
    choices.set("add", { kind: "add" });
    items.push({ name: "+ add model", description: "A model served by another endpoint (OpenAI-compatible)", key: "add" });
  }
  return {
    kind: "list",
    title: view.served === undefined ? "Models (asking the engine…)" : "Models",
    items,
    empty: "the engine lists no models",
    pick: (item) => {
      const choice = item.key === undefined ? undefined : choices.get(item.key);
      if (choice) choose(choice);
    },
  };
}

const STEPS = "Enter to continue · Esc to go back";

export function endpointPage(submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: "Add model · 1/3",
    label: "Endpoint",
    hint: `The address that serves /chat/completions, e.g. http://127.0.0.1:8080/v1 · ${STEPS}`,
    submit,
  };
}

export function keyPage(submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: "Add model · 2/3",
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
    title: `Add model · 3/3 · ${host}`,
    items: (served ?? []).map((s) => ({
      name: s.id,
      description: s.contextWindow ? `${s.contextWindow.toLocaleString("en-US")} tokens of context` : "",
    })),
    empty: "asking the endpoint which models it serves…",
    pick: (item) => {
      const model = served?.find((s) => s.id === item.name);
      if (model) choose(model);
    },
  };
}

export function namePage(host: string, submit: (text: string) => void): InputPage {
  return {
    kind: "input",
    title: `Add model · 3/3 · ${host}`,
    label: "Model",
    hint: `The endpoint did not list its models: type the model id · ${STEPS}`,
    submit,
  };
}
