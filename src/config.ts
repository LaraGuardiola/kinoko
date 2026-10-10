import { mkdir, writeFile } from "node:fs/promises";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export type ProviderName = "openai-compat" | "anthropic";

export interface Config {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  maxCost: number;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  // Hard cap on thinking tokens per reply (openai-compat `reasoning_budget_tokens`, as Strata and
  // llama.cpp-style engines read it). Unset: the engine's own default. Effort alone is only a hint.
  thinkingBudget?: number;
  // The configured provider's name in the models menu (strata, llama.cpp); its host when unset.
  label?: string;
  // Old thinking sent back: "turn" (since the user's last message, the default) or "none".
  thinkingReplay?: "turn" | "none";
  // A dropped connection or a 429/5xx is retried this many times in a row (2s, 4s, 8s...); 0: never.
  retries?: number;
  // The git repository /extensions installs from (kinoko-extensions when unset).
  extensionsRepo?: string;
}

export const DEFAULTS: Config = {
  provider: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.KINOKO_API_KEY ?? "",
  model: "gpt-4o-mini",
  maxTurns: 500, // a long coding task easily needs 100+ tool rounds; Esc is the real brake
  maxCost: 5,
  contextWindow: 128_000,
  maxOutputTokens: 8192,
}

const NUM_KEYS: ReadonlySet<string> = new Set(["maxTurns", "maxCost", "contextWindow", "maxOutputTokens", "thinkingBudget", "retries"]);
const FILE_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "baseUrl",
  "apiKey",
  "model",
  "maxTurns",
  "maxCost",
  "contextWindow",
  "maxOutputTokens",
  "reasoningEffort",
  "thinkingBudget",
  "label",
  "thinkingReplay",
  "retries",
  "extensionsRepo",
]);
const REPLAYS: ReadonlySet<string> = new Set(["turn", "none"]);
const EFFORTS: ReadonlySet<string> = new Set(["off", "low", "medium", "high"]);
const PROVIDERS: ReadonlySet<string> = new Set(["openai-compat", "anthropic"]);

type Loose = Record<string, string | number>;

/** Keeps only known keys with the right primitive type. */
function sanitize(raw: Loose): Partial<Config> {
  const out: Loose = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!FILE_KEYS.has(k)) continue;
    if (NUM_KEYS.has(k)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    } else if (k === "reasoningEffort") {
      if (typeof v === "string" && EFFORTS.has(v)) out[k] = v;
    } else if (k === "provider") {
      if (typeof v === "string" && PROVIDERS.has(v)) out[k] = v;
    } else if (k === "thinkingReplay") {
      if (typeof v === "string" && REPLAYS.has(v)) out[k] = v;
    } else if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

async function readJson(path: string): Promise<Partial<Config>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  try {
    const parsed: unknown = await file.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return sanitize(parsed as Loose);
  } catch {
    return {};
  }
}

function fromFlag(key: string, value: string): Partial<Config> {
  if (!FILE_KEYS.has(key)) return {};
  if (NUM_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? ({ [key]: n } as Partial<Config>) : {};
  }
  if (key === "reasoningEffort") {
    return EFFORTS.has(value) ? ({ reasoningEffort: value as ReasoningEffort } as Partial<Config>) : {};
  }
  if (key === "provider") return PROVIDERS.has(value) ? ({ provider: value as ProviderName } as Partial<Config>) : {};
  if (key === "thinkingReplay") return REPLAYS.has(value) ? ({ thinkingReplay: value as "turn" | "none" } as Partial<Config>) : {};
  return { [key]: value } as Partial<Config>;
}

/** Defaults < ~/.kinoko/config.json < ./.kinoko/config.json < CLI flags. */
export async function loadConfig(flags: Record<string, string | undefined> = {}): Promise<Config> {
  const layers: Array<Partial<Config>> = [DEFAULTS];
  const home = process.env.HOME ?? "";
  if (home) layers.push(await readJson(`${home}/.kinoko/config.json`));
  layers.push(await readJson(`${process.cwd()}/.kinoko/config.json`));
  for (const [k, v] of Object.entries(flags)) {
    if (v !== undefined) layers.push(fromFlag(k, v));
  }
  return Object.assign({}, ...layers) as Config;
}
/** The thinking level as the TUI shows it: "LOW · 2048", "OFF", or "DEFAULT" (the model's own). */
export function thinkingLabel(effort: ReasoningEffort | undefined, budget: number | undefined): string {
  const level = (effort ?? "default").toUpperCase();
  return budget && effort !== "off" ? `${level} · ${budget}` : level;
}

/** A model kinoko can switch to: where it is served and how to reach it. */
export interface SavedModel {
  model: string;
  baseUrl: string;
  apiKey: string;
  provider?: ProviderName; // openai-compat when absent
  contextWindow?: number;
  label?: string; // the provider's name in the models menu (strata, llama.cpp); its host when absent
}

/** Models added from the TUI live in ~/.kinoko/models.json; it holds API keys, so it is 0600. */
function modelsFile(home: string): string {
  return `${home}/.kinoko/models.json`;
}

function isSaved(value: unknown): value is SavedModel {
  const m = value as Partial<SavedModel> | null;
  return typeof m?.model === "string" && typeof m.baseUrl === "string" && typeof m.apiKey === "string";
}

export async function loadSavedModels(home = process.env.HOME ?? ""): Promise<SavedModel[]> {
  try {
    const parsed: unknown = await Bun.file(modelsFile(home)).json();
    return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
  } catch {
    return [];
  }
}

const sameModel = (a: SavedModel, b: SavedModel): boolean => a.baseUrl === b.baseUrl && a.model === b.model;

async function writeSaved(all: SavedModel[], home: string): Promise<SavedModel[]> {
  await mkdir(`${home}/.kinoko`, { recursive: true });
  await writeFile(modelsFile(home), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return all;
}

/** Adds (or replaces: same endpoint and model) one entry, and returns the list as now saved. */
export async function saveModel(entry: SavedModel, home = process.env.HOME ?? ""): Promise<SavedModel[]> {
  return writeSaved([...(await loadSavedModels(home)).filter((m) => !sameModel(m, entry)), entry], home);
}

/** Removes the entry with this endpoint and model, and returns the list as now saved. */
export async function removeModel(entry: SavedModel, home = process.env.HOME ?? ""): Promise<SavedModel[]> {
  return writeSaved((await loadSavedModels(home)).filter((m) => !sameModel(m, entry)), home);
}

/**
 * The entry a resumed session starts with: the model it last switched to, with the key and provider
 * of a known entry at that endpoint (the configured one first). Undefined when the session never
 * switched, or switched to an endpoint no longer known (then the configured model stands).
 */
export function resumeModel(
  last: { model: string; baseUrl: string; contextWindow?: number } | undefined,
  known: SavedModel[],
): SavedModel | undefined {
  if (last === undefined) return undefined;
  const exact = known.find((m) => m.baseUrl === last.baseUrl && m.model === last.model);
  const sameEndpoint = exact ?? known.find((m) => m.baseUrl === last.baseUrl);
  if (sameEndpoint === undefined) return undefined;
  // Another model's window says nothing about this one: only the session's or this model's own.
  const { contextWindow: _theirs, ...endpoint } = sameEndpoint;
  const contextWindow = last.contextWindow ?? exact?.contextWindow;
  return { ...endpoint, model: last.model, ...(contextWindow ? { contextWindow } : {}) };
}
