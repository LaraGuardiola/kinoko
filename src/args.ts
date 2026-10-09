// Command-line parsing: flags, the resume switches, the mode and a bare prompt. Pure, so it is tested
// on its own; main.ts acts on the result.

// CLI spelling -> Config key. Kebab-case is what a human types.
const FLAGS: Record<string, string> = {
  provider: "provider",
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
  "thinking-budget": "thinkingBudget",
  "thinking-replay": "thinkingReplay",
  thinkingReplay: "thinkingReplay",
  thinkingBudget: "thinkingBudget",
};

const RESUME_FLAGS = new Set(["continue", "c"]);
/** Single-dash spellings: `-c` is `--continue`. */
const SHORT_RESUME = "-c";
const MODES = new Set(["tui", "print", "rpc"]);

export function parseArgs(argv: string[]): {
  prompt?: string;
  flags: Record<string, string>;
  resume: boolean;
  session?: string;
  mode: "tui" | "print" | "rpc";
  explicitMode: boolean;
} {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  let resume = false;
  let session: string | undefined;
  // Bare `kinoko` means the interactive mode; `-p` and `--mode` are how you ask for the others.
  let mode: "tui" | "print" | "rpc" = "tui";
  let explicitMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--tui") {
      mode = "tui";
      explicitMode = true;
      continue;
    }
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (next !== undefined && MODES.has(next)) {
        mode = next as "tui" | "print" | "rpc";
        explicitMode = true;
        i++;
      }
      continue;
    }
    if (arg === SHORT_RESUME) {
      resume = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      const next = argv[i + 1];
      if (next !== undefined) prompt = next;
      mode = "print";
      explicitMode = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (RESUME_FLAGS.has(key)) {
        resume = true;
        continue;
      }
      if (key === "session") {
        session = argv[i + 1];
        i++;
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
  return { prompt, flags, resume, session, mode, explicitMode };
}
