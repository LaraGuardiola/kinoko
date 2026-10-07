import { loadConfig } from "./config.ts";
import { openaiCompat } from "./providers/openai-compat.ts";
import { Agent } from "./loop.ts";
import type { AgentEvent } from "./loop.ts";
import { Session, latestSession } from "./session.ts";
import { Extensions, loadExtensions } from "./ext.ts";
import { App } from "./tui/app.ts";
import { Term } from "./tui/term.ts";
import { ansi } from "./tui/render.ts";
import { discoverContext, discoverSkills } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { defaultTools } from "./tools/registry.ts";
import { Rpc, serveStdio } from "./rpc.ts";

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
const MODES = new Set(["tui", "print", "rpc"]);

function parseArgs(argv: string[]): {
  prompt?: string;
  flags: Record<string, string>;
  resume: boolean;
  mode: "tui" | "print" | "rpc";
  explicitMode: boolean;
} {
  const flags: Record<string, string> = {};
  let prompt: string | undefined;
  let resume = false;
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
  return { prompt, flags, resume, mode, explicitMode };
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

const { prompt, flags, resume, mode: askedMode, explicitMode } = parseArgs(process.argv.slice(2));
// No prompt and no explicit mode: the interactive one, if there is a terminal to draw on.
const mode = explicitMode || prompt !== undefined ? askedMode : process.stdin.isTTY ? "tui" : "print";
const tui = mode === "tui";
if (tui && prompt) {
  process.stderr.write("note: the TUI takes no prompt; type it in the editor\n");
}
if (!prompt && mode === "print") {
  process.stderr.write('usage: kinoko                 (interactive)\n');
  process.stderr.write('       kinoko -p "prompt"      (print mode)\n');
  process.stderr.write('       kinoko --mode rpc       (JSONL on stdin)\n');
  process.exit(1);
}

const cwd = process.cwd();

// Extensions load first and need nothing but the cwd, so a slash command works without an engine.
const ext = new Extensions();
for (const path of await loadExtensions(ext, { cwd: cwd })) process.stderr.write(`[ext] loaded ${path}\n`);

if (prompt !== undefined && prompt.startsWith("/")) {
  const [name, ...rest] = prompt.slice(1).split(" ");
  const command = ext.command(name ?? "");
  if (command === undefined) {
    const known = ext.commandNames();
    process.stderr.write(
      `unknown command /${name ?? ""}${known.length > 0 ? ` (available: ${known.map((c) => `/${c}`).join(", ")})` : " (no extensions loaded)"}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${await command(rest.join(" "))}\n`);
  process.exit(0);
}

const config = await loadConfig(flags);
if (!config.apiKey) {
  process.stderr.write("no apiKey: set it in ~/.kinoko/config.json, ./.kinoko/config.json, or --api-key\n");
  process.exit(1);
}

// Everything the prompt needs is read once here: the date is frozen and the context never
// changes, so the bytes before the first user message stay identical for the whole session.
const system = buildSystemPrompt({
  cwd,
  date: new Date().toISOString().slice(0, 10),
  tools: [...defaultTools(), ...ext.tools()],
  context: await discoverContext(cwd),
  skills: await discoverSkills(cwd),
});

const previous = resume && mode === "print" ? latestSession(cwd) : undefined;
const session = previous ? await Session.load(previous) : await Session.create({ cwd, model: config.model });
if (previous) process.stderr.write(`[resumed ${session.meta.id}]\n`);
ext.emit("session_start", { cwd: cwd, model: config.model });

const agent = new Agent({
  provider: openaiCompat({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
  }),
  model: config.model,
  system,
  tools: [...defaultTools(), ...ext.tools()],
  maxTurns: config.maxTurns,
  maxCost: config.maxCost,
  contextWindow: config.contextWindow,
  session,
  extensions: ext,
});

const startedAt = Date.now();

if (tui) {
  // The interactive mode: raw terminal in, live region out. Everything else is the same Agent.
  const term = new Term();
  const app = new App({
    agent: agent,
    write: (text) => term.write(text),
    model: config.model,
    contextWindow: config.contextWindow,
    viewportRows: term.rows,
    viewportCols: term.cols,
    session: session,
    onQuit: () => {
      term.stop();
      process.exit(0);
    },
  });
  term.on({ key: (key) => app.handleKey(key), resize: (cols, rows) => app.resize(cols, rows) });
  const loop = setInterval(() => {
    term.pollKeys(); // a lone Esc waits one frame before it counts
    app.render();
  }, 33);
  term.start();
  // Start the full-height live region at a known terminal origin. Without this, drawing below
  // the shell prompt can scroll the region and invalidate the renderer's row-relative cursor math.
  term.write(`${ansi.clearScreen}${ansi.hide}`);
  app.render();
  process.on("SIGINT", () => app.handleKey({ name: "ctrl-c" }));
  await new Promise<void>(() => undefined); // runs until the user quits
  clearInterval(loop);
} else if (mode === "rpc") {
  const rpc = new Rpc({
    agent: agent,
    model: config.model,
    write: (text) => process.stdout.write(text),
    // stdin closed: the client is gone, so the run and the process end here.
    onClose: () => {
      agent.abort();
      process.exit(0);
    },
  });
  serveStdio(rpc);
  process.on("SIGINT", () => agent.abort());
  await new Promise<void>(() => undefined); // runs until stdin closes
} else {
  // Print mode: the agent loop runs to the end, tool activity stays on stderr, and an aborted or
  // failed run exits non-zero so a script can tell.
  print(agent);
  process.on("SIGINT", () => agent.abort());
  const result = await agent.prompt(prompt ?? "");
  process.stdout.write("\n");
  process.stderr.write(`[${result.reason}] session ${session.meta.id}\n`);
  process.exit(result.reason === "done" ? 0 : 1);
}
