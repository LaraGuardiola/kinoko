import { loadConfig } from "./config.ts";
import { openaiCompat } from "./providers/openai-compat.ts";
import { Agent } from "./loop.ts";
import type { AgentEvent } from "./loop.ts";
import { Session, latestSession } from "./session.ts";
import { discoverContext, discoverSkills } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { defaultTools } from "./tools/registry.ts";

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

const RESUME_FLAGS = new Set(["continue", "c"]);

function parseArgs(argv: string[]): { prompt?: string; flags: Record<string, string>; resume: boolean } {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-p" || arg === "--print") {
      const next = argv[i + 1];
      if (next !== undefined) prompt = next;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (RESUME_FLAGS.has(key)) {
        resume = true;
        continue;
      }
      const mapped = FLAGS[key];
      if (!mapped) continue;
      const next = argv[i + 1];
      if (next !== undefined) {
        flags[mapped] = next;
        i++;
      }
    } else if (prompt === undefined) {
      prompt = arg;
    }
  }
  return { prompt, flags, resume };
}

/** Text to stdout, everything else (thinking, tool activity, timing) to stderr. */
function print(agent: Agent): void {
  agent.on((e: AgentEvent) => {
    switch (e.type) {
      case "message_delta":
        process.stdout.write(e.delta);
        break;
      case "message_end":
        if (e.message.thinking) process.stderr.write(`[thinking] ${e.message.thinking.slice(0, 200)}\n`);
        break;
      case "tool_start":
        process.stderr.write(`[tool] ${e.call.name} ${JSON.stringify(e.call.args ?? {}).slice(0, 160)}\n`);
        break;
      case "tool_end":
        process.stderr.write("[tool done]\n");
        break;
      case "first_token":
        process.stderr.write(`[first token after ${e.at - startedAt}ms]\n`);
        break;
      case "compacted":
        process.stderr.write(`[compacted: ${e.keep} messages kept verbatim]\n`);
        break;
      case "run_end":
        process.stderr.write(`[${e.reason}]\n`);
        break;
      default:
        break;
    }
  });
}

const { prompt, flags, resume } = parseArgs(process.argv.slice(2));
if (!prompt) {
  process.stderr.write('usage: bun run src/main.ts [-p] "your prompt" [--continue]\n');
  process.exit(1);
}

const config = await loadConfig(flags);
if (!config.apiKey) {
  process.stderr.write("no apiKey: set it in ~/.kinoko/config.json, ./.kinoko/config.json, or --api-key\n");
  process.exit(1);
}

const cwd = process.cwd();
// Everything the prompt needs is read once here: the date is frozen and the context never
// changes, so the bytes before the first user message stay identical for the whole session.
const system = buildSystemPrompt({
  cwd,
  date: new Date().toISOString().slice(0, 10),
  tools: defaultTools(),
  context: await discoverContext(cwd),
  skills: await discoverSkills(cwd),
});

const previous = resume ? latestSession(cwd) : undefined;
const session = previous ? await Session.load(previous) : await Session.create({ cwd, model: config.model });
if (previous) process.stderr.write(`[resumed ${session.meta.id}]\n`);

const agent = new Agent({
  provider: openaiCompat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
  }),
  model: config.model,
  system,
  tools: defaultTools(),
  maxTurns: config.maxTurns,
  maxCost: config.maxCost,
  contextWindow: config.contextWindow,
  session,
});

const startedAt = Date.now();
print(agent);
process.on("SIGINT", () => agent.abort());
const result = await agent.prompt(prompt);
process.stdout.write("\n");
process.stderr.write(`[${result.reason}] session ${session.meta.id}\n`);