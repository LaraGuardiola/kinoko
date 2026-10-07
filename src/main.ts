import { loadConfig } from "./config.ts";
import { openaiCompat } from "./providers/openai-compat.ts";
import type { Message, Provider } from "./types.ts";

// CLI spelling -> Config key. Kebab-case is what a human types.
const FLAGS: Record<string, string> = {
  "base-url": "baseUrl",
  baseUrl: "baseUrl",
  "api-key": "apiKey",
  apiKey: "apiKey",
  model: "model",
  "max-turns": "maxTurns",
  maxTurns: "maxTurns",
  "max-cost": "maxCost",
  maxCost: "maxCost",
  "context-window": "contextWindow",
  contextWindow: "contextWindow",
  "max-output-tokens": "maxOutputTokens",
  maxOutputTokens: "maxOutputTokens",
  "reasoning-effort": "reasoningEffort",
  reasoningEffort: "reasoningEffort",
};

function parseArgs(argv: string[]): { prompt?: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-p" || arg === "--print") {
      const next = argv[i + 1];
      if (next !== undefined) prompt = next;
      i++;
    } else if (arg.startsWith("--")) {
      const key = FLAGS[arg.slice(2)];
      if (!key) continue;
      const next = argv[i + 1];
      if (next !== undefined) {
        flags[key] = next;
        i++;
      }
    } else if (prompt === undefined) {
      prompt = arg;
    }
  }
  return { prompt, flags };
}

async function print(provider: Provider, model: string, prompt: string): Promise<void> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  try {
    const messages: Message[] = [{ id: "1", role: "user", content: prompt }];
    let stop: string = "end";
    for await (const ev of provider.stream({ model, system: "", messages, tools: [], signal: controller.signal })) {
      if (ev.type === "text") process.stdout.write(ev.delta);
      else if (ev.type === "error") process.stderr.write(`\n${ev.message}\n`);
      else if (ev.type === "done") stop = ev.stop;
    }
    if (stop !== "end") process.stderr.write(`\n[${stop}]\n`);
  } finally {
    process.off("SIGINT", onSignal);
  }
}

const { prompt, flags } = parseArgs(process.argv.slice(2));
if (!prompt) {
  process.stderr.write('usage: bun run src/main.ts -p "your prompt"\n');
  process.exit(1);
}

const config = await loadConfig(flags);
if (!config.apiKey) {
  process.stderr.write("no apiKey: set it in ~/.kinoko/config.json, ./.kinoko/config.json, or --api-key\n");
  process.exit(1);
}
const provider = openaiCompat({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  reasoningEffort: config.reasoningEffort,
  maxOutputTokens: config.maxOutputTokens,
});
await print(provider, config.model, prompt);