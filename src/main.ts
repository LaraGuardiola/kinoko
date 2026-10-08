import { DEFAULTS, loadConfig, thinkingLabel } from "./config.ts";
import { openaiCompat } from "./providers/openai-compat.ts";
import { anthropic, modelInfo } from "./providers/anthropic.ts";
import { Agent } from "./loop.ts";
import type { AgentEvent } from "./loop.ts";
import { Session, findSession, latestSession } from "./session.ts";
import { rmSync } from "node:fs";
import { Extensions, loadExtensions } from "./ext.ts";
import { App } from "./tui/app.ts";
import { Term } from "./tui/term.ts";
import { placeLine } from "./tui/place.ts";
import { ansi } from "./tui/render.ts";
import { ANSI } from "./tui/style.ts";
import { discoverContext, discoverSkills } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { defaultTools } from "./tools/registry.ts";
import { Rpc, serveStdio } from "./rpc.ts";

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
  thinkingBudget: "thinkingBudget",
};

const RESUME_FLAGS = new Set(["continue", "c"]);
const MODES = new Set(["tui", "print", "rpc"]);

function parseArgs(argv: string[]): {
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
        process.stderr.write(`[${e.reason}${e.detail ? `: ${e.detail}` : ""}]\n`);
        break;
      default:
        break;
    }
  });
}

const { prompt, flags, resume, session: sessionId, mode: askedMode, explicitMode } = parseArgs(process.argv.slice(2));
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
const VERSION = "0.1.0";

// Extensions load first and need nothing but the cwd, so a slash command works without an engine.
const ext = new Extensions();
const extensionPaths = await loadExtensions(ext, { cwd: cwd });
for (const path of extensionPaths) process.stderr.write(`[ext] loaded ${path}\n`);

if (prompt !== undefined && prompt.startsWith("/")) {
  const [name, ...rest] = prompt.slice(1).split(" ");
  const command = ext.command(name ?? "");
  if (command === undefined) {
    const known = ext.commandNames();
    process.stderr.write(
      `unknown command /${name ?? ""}${known.length > 0 ? ` (available: ${known.map((c) => `/${c}`).join(", ")})` : " (no extension registers a command)"}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${await command(rest.join(" "))}\n`);
  process.exit(0);
}

const config = await loadConfig(flags);
if (config.provider === "anthropic") {
  // Values still at the generic defaults take the provider's and the model's own.
  if (config.baseUrl === DEFAULTS.baseUrl) config.baseUrl = "https://api.anthropic.com";
  if (!config.apiKey) config.apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const info = modelInfo(config.model);
  if (info && config.contextWindow === DEFAULTS.contextWindow) config.contextWindow = info.contextWindow;
  if (info && config.maxOutputTokens === DEFAULTS.maxOutputTokens) config.maxOutputTokens = Math.min(info.maxOutput, 64_000);
}
if (!config.apiKey) {
  process.stderr.write("no apiKey: set it in ~/.kinoko/config.json, ./.kinoko/config.json, or --api-key\n");
  process.exit(1);
}

// Everything the prompt needs is read once here: the date is frozen and the context never
// changes, so the bytes before the first user message stay identical for the whole session.
const context = await discoverContext(cwd);
const skills = await discoverSkills(cwd);
const system = buildSystemPrompt({
  cwd,
  date: new Date().toISOString().slice(0, 10),
  tools: [...defaultTools(), ...ext.tools()],
  context,
  skills,
});

// Sessions are kept per directory: `--session <id>` (or a unique prefix) is looked up in this
// directory's sessions only, `--continue` takes its newest one.
const previous = sessionId !== undefined ? findSession(cwd, sessionId) : resume ? latestSession(cwd) : undefined;
if (sessionId !== undefined && previous === undefined) {
  process.stderr.write(`no session "${sessionId}" in ${cwd}: sessions are kept per directory, run kinoko where you started it\n`);
  process.exit(1);
}
const session = previous ? await Session.load(previous) : await Session.create({ cwd, model: config.model });
if (previous && !tui) process.stderr.write(`[resumed ${session.meta.id}]\n`);
ext.emit("session_start", { cwd: cwd, model: config.model });

const agent = new Agent({
  provider: (config.provider === "anthropic" ? anthropic : openaiCompat)({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    thinkingBudget: config.thinkingBudget,
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
  const startup = startupPanel({ context, skills, extensions: extensionPaths, version: VERSION });
  const app = new App({
    agent: agent,
    write: (text) => term.write(text),
    model: config.model,
    contextWindow: config.contextWindow,
    thinking: thinkingLabel(config.reasoningEffort, config.thinkingBudget),
    // Same rule as App.resize: the panel above simply scrolls away into the scrollback.
    viewportRows: Math.max(2, term.rows - 1),
    viewportCols: term.cols,
    place: () => placeLine(cwd),
    session: session,
    onQuit: () => {
      term.stop();
      process.stdout.write(farewell(session));
      process.exit(0);
    },
  });
  term.on({ key: (key) => app.handleKey(key), resize: (cols, rows) => app.resize(cols, rows) });
  const loop = setInterval(() => {
    term.pollKeys(); // a lone Esc waits one frame before it counts
    app.render();
  }, 33);
  term.start();
  term.write(`${ansi.clearScreen}${ansi.hide}\n`);
  app.intro(startup);
  if (previous) app.replay(agent.messages, `resumed session ${session.meta.id}`);
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

function startupPanel(parts: { context: { path: string }[]; skills: { name: string }[]; extensions: string[]; version: string }): string {
  return [
    `${ANSI.amanita}kinoko${ANSI.reset} ${ANSI.cream}v${parts.version}${ANSI.reset}`,
    "",
    "\x1b[38;5;214m[Capabilities]\x1b[0m",
    `  Context: ${names(parts.context.map((file) => file.path.split("/").at(-1) ?? file.path), "none")}`,
    `  Skills: ${names(parts.skills.map((skill) => skill.name), "none")}`,
    `  Extensions: ${names(parts.extensions.map((path) => path.split("/").at(-1) ?? path), "none")}`,
    "",
    "Kinoko can inspect and change this project. Ask it to work on a coding task.",
  ].join("\n");
}

/**
 * What is left on screen when the TUI closes: the command that resumes this session, ready to
 * copy. A session nothing was said in is deleted instead: nothing to resume, nothing to keep.
 */
function farewell(ended: Session): string {
  if (ended.empty) {
    rmSync(ended.path, { force: true });
    return "";
  }
  return `\n${ANSI.dim}resume this session with${ANSI.reset}  ${ANSI.cream}kinoko --session ${ended.meta.id}${ANSI.reset}\n`;
}

function names(items: string[], empty: string): string {
  return items.length === 0 ? empty : items.join(", ");
}
