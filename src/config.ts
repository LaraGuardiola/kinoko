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

const NUM_KEYS: ReadonlySet<string> = new Set(["maxTurns", "maxCost", "contextWindow", "maxOutputTokens", "thinkingBudget"]);
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
]);
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