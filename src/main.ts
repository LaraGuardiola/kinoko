import { DEFAULTS, loadConfig, loadSavedModels, removeModel, resumeModel, saveModel, setDefaultModel, thinkingLabel } from "./config.ts";
import type { SavedModel } from "./config.ts";
import type { Provider } from "./types.ts";
import { isLocal, listModels, openaiCompat } from "./providers/openai-compat.ts";
import { anthropic, modelInfo } from "./providers/anthropic.ts";
import { Agent } from "./loop.ts";
import type { AgentEvent } from "./loop.ts";
import { Session, findSession, latestSession } from "./session.ts";
import { readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Extensions, extensionName, loadExtensions, loadOne } from "./ext.ts";
import { EXTENSIONS, SKILLS, catalog } from "./catalog.ts";
import type { Change } from "./catalog.ts";
import { App } from "./tui/app.ts";
import { THINKING, profileLabel } from "./tui/menu-pages.ts";
import { activeProfile } from "./profiles.ts";
import { mushroomArt } from "./tui/mushroom-art.ts";
import { integrationsSummary, readIntegrations } from "./integrations.ts";
import type { CommandHost } from "./commands.ts";
import { setFenceRenderers } from "./tui/markdown.ts";
import { Term } from "./tui/term.ts";
import { placeLine } from "./tui/place.ts";
import { ansi } from "./tui/render.ts";
import { ANSI } from "./tui/style.ts";
import { discoverContext, discoverSkills, frontmatter } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { defaultTools } from "./tools/registry.ts";
import { restoreTracker } from "./tools/restore.ts";
import { tracker } from "./tools/tracker.ts";
import { Rpc, serveStdio } from "./rpc.ts";
import { parseArgs } from "./args.ts";
import { Jobs, endNote } from "./jobs.ts";
import { userHome } from "./home.ts";
import { shell, userShellArgv } from "./shell.ts";
import { VERSION } from "./version.ts";

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
        if (e.keep >= 0) process.stderr.write(`[compacted: ${e.keep} messages kept verbatim]\n`);
        break;
      case "retry":
        process.stderr.write(`[${e.error} · retry ${e.attempt}/${e.of} in ${Math.round(e.inMs / 1000)}s]\n`);
        break;
      case "run_end":
        process.stderr.write(`[${e.reason}${e.detail ? `: ${e.detail}` : ""}]\n`);
        break;
      default:
        break;
    }
  });
}

// `kinoko --version`: what is installed, and nothing else.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  process.stdout.write(`kinoko ${VERSION}\n`);
  process.exit(0);
}

// `kinoko serve ...`: the hub for the phone app, a program of its own (it runs agents as children).
if (process.argv[2] === "serve") {
  const { runServe } = await import("./serve/main.ts");
  // Children run this same kinoko: the compiled binary itself, or bun with this file.
  const command = Bun.main.endsWith(".ts") ? [process.execPath, Bun.main] : [process.execPath];
  await runServe(process.argv.slice(3), { command, version: VERSION });
  process.exit(process.exitCode ?? 0);
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
  process.stderr.write('       kinoko serve            (the hub for the phone app)\n');
  process.exit(1);
}

const cwd = process.cwd();

// Extensions load first and need nothing but the cwd, so a slash command works without an engine.
const ext = new Extensions();
const extensionPaths = await loadExtensions(ext, { cwd: cwd });
const loadedExtensions = new Set(extensionPaths.map(extensionName)); // /extensions changes it live
for (const path of extensionPaths) process.stderr.write(`[ext] loaded ${path}\n`);
setFenceRenderers((lang) => ext.renderer(lang)); // ```mermaid and the like, drawn by extensions

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
// Nothing set up (no config.json or flag names a model, endpoint or key): the model last added in
// /models, so what is set up from the TUI holds from then on. Nothing there either: the TUI starts
// without a model and leads to /models; the other modes cannot, and say how.
const setUp = config.apiKey !== "" || config.model !== DEFAULTS.model || config.baseUrl !== DEFAULTS.baseUrl;
const lastAdded = setUp ? undefined : (await loadSavedModels()).at(-1);
if (lastAdded) {
  Object.assign(config, { model: lastAdded.model, baseUrl: lastAdded.baseUrl, apiKey: lastAdded.apiKey, provider: lastAdded.provider ?? "openai-compat" });
  if (lastAdded.contextWindow) config.contextWindow = lastAdded.contextWindow;
  if (lastAdded.label) config.label = lastAdded.label;
}
let noModel = !setUp && lastAdded === undefined;
if (noModel && !tui) {
  process.stderr.write("no model set up yet: open kinoko (no arguments) and add one in /models, or write ~/.kinoko/config.json\n");
  process.exit(1);
}
if (noModel) config.model = "";

// Sessions are kept per directory: `--session <id>` (or a unique prefix) is looked up in this
// directory's sessions only, `--continue` takes its newest one.
const previous = sessionId !== undefined ? findSession(cwd, sessionId) : resume ? latestSession(cwd) : undefined;
if (sessionId !== undefined && previous === undefined) {
  process.stderr.write(`no session "${sessionId}" in ${cwd}: sessions are kept per directory, run kinoko where you started it\n`);
  process.exit(1);
}
// `let`: /new starts another one (the prompt below reads the current one's date).
let session = previous ? await Session.load(previous) : await Session.create({ cwd, model: config.model });
if (previous && !tui) process.stderr.write(`[resumed ${session.meta.id}]\n`);

// Everything the prompt needs is read once here: the date is frozen and the context never
// changes, so the bytes before the first user message stay identical for the whole session. The
// date is the session's own: a session resumed the next day keeps its prompt, and the engine's cache.
const context = await discoverContext(cwd);
let skills = await discoverSkills(cwd); // read again by /new
/** The OS and the bash tool's shell, for the prompt: what commands work here. */
const systemLine = (): string => `${{ linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform as string] ?? process.platform}; the bash tool runs ${shell().name}`;

// The prompt names the model, so a switch from the models menu gets its own (the engine's cache is
// lost on a switch anyway); for one model it stays byte-stable.
const system = (model: string): string =>
  buildSystemPrompt({
    cwd,
    model,
    date: new Date(session.meta.created).toISOString().slice(0, 10),
    tools: [...defaultTools(), ...ext.tools()],
    context,
    skills,
    system: systemLine(),
  });

ext.emit("session_start", { cwd: cwd, model: config.model, mode: mode });

const providerOptions = {
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  reasoningEffort: config.reasoningEffort,
  maxOutputTokens: config.maxOutputTokens,
  thinkingBudget: config.thinkingBudget,
  thinkingReplay: config.thinkingReplay,
};
// The model in the config, as the models menu offers it next to the ones added from the TUI.
let configured: SavedModel = {
  model: config.model,
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  provider: config.provider,
  contextWindow: config.contextWindow,
  ...(config.label ? { label: config.label } : {}),
};
const saved = await loadSavedModels();
const connect = (entry: SavedModel): Provider =>
  (entry.provider === "anthropic" ? anthropic : openaiCompat)({ ...providerOptions, baseUrl: entry.baseUrl, apiKey: entry.apiKey });
// A resumed session starts with the model it last switched to (endpoint and window too), not the default.
const start = resumeModel(session.model, [configured, ...saved]) ?? configured;
// The engine takes a thinking budget: a configured one says so, and local engines (llama.cpp, Strata) do.
const budgets = config.thinkingBudget !== undefined || isLocal(start.baseUrl);
const startWindow = start.contextWindow ?? config.contextWindow;
// Background jobs (bash background: true): when one ends the agent is told, woken when idle.
// Print mode ends with its run, so it has none.
const jobs =
  mode === "print"
    ? undefined
    : new Jobs({
        dir: join(userHome(), ".kinoko", "jobs"),
        onEnd: (job) => {
          const note = endNote(job, jobs?.tail(job.id, 15) ?? []);
          if (agent.state === "running") agent.steer(note);
          // Stopped by the user: told with their next message, not worth waking the model for.
          else if (job.state === "killed") agent.note(note.replace(/^\[kinoko\] /, ""));
          else void agent.prompt(note).catch(() => agent.steer(note)); // one started meanwhile
        },
      });
// A job never outlives kinoko: not on quit, and not when kinoko serve stops an agent (SIGTERM).
process.on("exit", () => jobs?.killAll());
// How many run, told to the clients when it changes (the phone shows ⚙ N on the agent).
let jobsRunning = 0;
jobs?.on(() => {
  if (jobs.running === jobsRunning) return;
  jobsRunning = jobs.running;
  agent.announce({ type: "jobs", running: jobsRunning });
});
// Closing the terminal's window hangs kinoko up (SIGHUP): its jobs go with it too.
if (jobs) {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGHUP", () => process.exit(129));
}
const agent = new Agent({
  provider: connect(start),
  model: start.model,
  system,
  tools: [...defaultTools(), ...ext.tools()],
  maxTurns: config.maxTurns,
  maxCost: config.maxCost,
  contextWindow: startWindow,
  session,
  extensions: ext,
  retries: config.retries,
  // Print mode has nobody to ask: an approval there is a deny at once.
  approvalTimeoutMs: mode === "print" ? 0 : config.approvalTimeoutMs,
  ...(jobs ? { background: (command: string, at: string) => jobs.start(command, at) } : {}),
});

// A resumed session already read or wrote files: those still on disk exactly as it last saw them
// need no fresh read before a change (the read-before-change record does not survive a restart).
if (previous) await restoreTracker(agent.messages, cwd);

const startedAt = Date.now();

// The profile chosen last (/profile): its thinking level and how approvals go, from the start.
const startProfile = mode === "print" ? undefined : await activeProfile(userHome());
const startThinking = THINKING.find((p) => p.name === startProfile?.thinking);
if (startThinking) agent.setThinking(startThinking.effort, budgets ? startThinking.budget : undefined);
if (startProfile?.approvals === "auto") agent.setAutoApprove(true);
/** The panel's profile line: which, and whether it asks. */
const profileLine = async (): Promise<string | undefined> => {
  const p = await activeProfile(userHome());
  return p ? `${p.title}${p.approvals === "auto" ? " · nothing asked" : ""}` : undefined;
};

/** The mushroom's face and the line beside it: the profile in use, and what it is about. */
const faceOf = async (): Promise<{ face?: string; tagline?: string }> => {
  const p = await activeProfile(userHome());
  return p ? { face: p.name, tagline: p.description } : {};
};

/** The panel's integrations line: Telegram set up, and whether it runs. */
const integrationsLine = async (): Promise<string> => integrationsSummary(await readIntegrations(userHome()));

if (tui) {
  // The interactive mode: raw terminal in, live region out. Everything else is the same Agent.
  const term = new Term();
  const startup = startupPanel({ context, skills, extensions: [...loadedExtensions], version: VERSION, profile: await profileLine(), ...(await faceOf()), integrations: await integrationsLine() });
  const app = new App({
    agent: agent,
    noModel,
    extensionCommands: { list: () => ext.commandList(), get: (name) => ext.command(name) },
    write: (text) => term.write(text),
    model: start.model,
    contextWindow: startWindow,
    thinking: startThinking ? profileLabel(startThinking, budgets) : thinkingLabel(config.reasoningEffort, config.thinkingBudget),
    thinkingProfile: startThinking?.name ?? THINKING.find((p) => p.effort === config.reasoningEffort && (!config.thinkingBudget || p.budget === config.thinkingBudget))?.name,
    budgets,
    models: {
      endpoint: start.baseUrl,
      saved: noModel ? saved : [configured, ...saved], // no model yet: nothing configured to offer
      connect: connect,
      discover: listModels,
      // The configured model stays first: it is always there to go back to, and cannot be removed.
      save: async (entry) => [...(noModel ? [] : [configured]), ...(await saveModel(entry))],
      remove: async (entry) => [...(noModel ? [] : [configured]), ...(await removeModel(entry))],
      fixed: (entry) => entry.baseUrl === configured.baseUrl && entry.model === configured.model,
      // The default moves into config.json, and the one it replaces into the saved ones: still there to pick.
      setDefault: async (entry) => {
        if (!noModel) await saveModel(configured);
        await setDefaultModel(entry);
        configured = entry;
        noModel = false;
        return [configured, ...(await removeModel(entry))];
      },
    },
    // Same rule as App.resize: the panel above simply scrolls away into the scrollback.
    extensions: catalog({ kind: EXTENSIONS, home: userHome(), repo: config.extensionsRepo }),
    skills: catalog({ kind: SKILLS, home: userHome(), repo: config.skillsRepo }),
    apply: (kind, name, change) => (kind === "extensions" ? applyExtension(name, change) : applySkill(name, change)),
    // What is on now, for the panel's [Capabilities] lines (skills read again: one may be new).
    jobs,
    capabilities: async () => startupPanel({ context, skills: await discoverSkills(cwd), extensions: [...loadedExtensions], version: VERSION, profile: await profileLine(), ...(await faceOf()), integrations: await integrationsLine() }),
    resumeSession: async (path) => {
      // Another of this directory's sessions, in place of this one: the model in use stays.
      const last = session;
      session = await Session.load(path);
      skills = await discoverSkills(cwd);
      tracker.reset();
      agent.restart(session);
      await restoreTracker(agent.messages, cwd);
      if (last.empty) await rm(last.path, { force: true });
      return { session, intro: startupPanel({ context, skills, extensions: [...loadedExtensions], version: VERSION, profile: await profileLine(), ...(await faceOf()), integrations: await integrationsLine() }) };
    },
    newSession: async () => {
      // A new conversation: a new session file, the skills read again (installed ones join the
      // prompt), and no file counts as read until the model reads it in this conversation.
      const last = session;
      session = await Session.create({ cwd, model: agent.model });
      skills = await discoverSkills(cwd);
      tracker.reset();
      agent.restart(session);
      // The last one: deleted when nothing was said in it (as on quit), else how to come back to it.
      if (last.empty) await rm(last.path, { force: true });
      const back = last.empty ? "" : `\n\n${ANSI.dim}the last session:${ANSI.reset} ${ANSI.cream}kinoko --session ${last.meta.id}${ANSI.reset}`;
      return { session, intro: startupPanel({ context, skills, extensions: [...loadedExtensions], version: VERSION, profile: await profileLine(), ...(await faceOf()), integrations: await integrationsLine() }) + back };
    },
    viewportRows: Math.max(2, term.rows - 1),
    viewportCols: term.cols,
    place: () => placeLine(cwd),
    session: session,
    // The user's shell on this terminal: kinoko lets go of it (raw mode, keys, mouse) and takes it
    // back when the shell ends. A Ctrl-C meanwhile is the shell's (the App ignores the SIGINT).
    handOver: async (command) => {
      const size = `${term.cols}x${term.rows}`;
      term.stop();
      try {
        const child = Bun.spawn(userShellArgv(command), { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        return await child.exited;
      } finally {
        term.start();
        // Resized meanwhile: once the App is back, it hears the new size (only then: a resize
        // redraws the screen from kinoko's history, and the shell's output is not in it).
        if (`${term.cols}x${term.rows}` !== size) setTimeout(() => app.resize(term.cols, term.rows), 0);
      }
    },
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
  app.noModelHint();
  void app.checkModel();
  if (previous) app.replay(agent.messages, `resumed session ${session.meta.id}`);
  app.locate(); // where the region sits on the screen: the side column is drawn from its top row
  // While `kinoko serve` runs, this terminal shows up in the phone app (KINOKO_LINK=0: it does not).
  if (process.env.KINOKO_LINK !== "0") {
    const { hubSocket, linkToHub } = await import("./serve/link.ts");
    linkToHub({ agent, socket: hubSocket(userHome()), cwd, model: () => agent.model, session: () => session.meta.id, commands: app.commandHost() });
  }
  process.on("SIGINT", () => app.handleKey({ name: "ctrl-c" }));
  await new Promise<void>(() => undefined); // runs until the user quits
  clearInterval(loop);
} else if (mode === "rpc") {
  // The phone's slash commands, for an agent kinoko serve started: the same as the TUI's menu.
  let profile = startThinking?.name ?? THINKING.find((p) => p.effort === config.reasoningEffort && (!config.thinkingBudget || p.budget === config.thinkingBudget))?.name;
  const commands: CommandHost = {
    agent,
    catalogs: {
      extensions: catalog({ kind: EXTENSIONS, home: userHome(), repo: config.extensionsRepo }),
      skills: catalog({ kind: SKILLS, home: userHome(), repo: config.skillsRepo }),
    },
    apply: (kind, name, change) => (kind === "extensions" ? applyExtension(name, change) : applySkill(name, change)),
    newSession: async () => {
      const last = session;
      session = await Session.create({ cwd, model: agent.model });
      skills = await discoverSkills(cwd);
      tracker.reset();
      agent.restart(session);
      if (last.empty) await rm(last.path, { force: true });
    },
    thinking: {
      current: () => profile,
      set: (name) => {
        const chosen = THINKING.find((p) => p.name === name);
        if (chosen === undefined) return `no thinking profile ${name}`;
        agent.setThinking(chosen.effort, budgets ? chosen.budget : undefined);
        profile = chosen.name;
        return `thinking: ${chosen.name} from the next request`;
      },
    },
    session: () => `id ${session.meta.id}\nmessages ${agent.messages.length}\nmodel ${agent.model}`,
    ...(jobs ? { jobs } : {}),
  };
  const rpc = new Rpc({
    agent: agent,
    model: () => agent.model,
    session: () => session.meta.id,
    cwd: cwd,
    commands,
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

/**
 * An extension installed or removed from /extensions, in effect now: loaded afresh (or taken back),
 * and the agent's tools follow. Tools are part of every request's opening bytes, so a change to them
 * makes a local engine read the whole prompt again: said, so the next slow answer is no surprise.
 */
async function applyExtension(name: string, change: Change): Promise<string> {
  const before = ext.tools().map((t) => t.name).join(",");
  const load = change === "install" || change === "enable";
  let failed: string | undefined;
  if (load) failed = await loadOne(ext, join(userHome(), ".kinoko", "ext", name, "index.ts"));
  else ext.unload(name);
  if (failed) return failed;
  if (load) loadedExtensions.add(name);
  else loadedExtensions.delete(name);
  agent.setTools([...defaultTools(), ...ext.tools()]);
  const toolsChanged = ext.tools().map((t) => t.name).join(",") !== before;
  const done = load ? "loaded" : "unloaded";
  return toolsChanged ? `${done}; its tools change the prompt, so the next request reads it all again` : done;
}

/**
 * A skill installed or removed from /skills, told to the model as a note before your next message.
 * The skills index in the system prompt stays as it was (byte-stable, so the engine's cache too);
 * the next start lists the skill there.
 */
async function applySkill(name: string, change: Change): Promise<string> {
  const installed = join(userHome(), ".kinoko", "skills", name, "SKILL.md");
  const sharedPath = join(userHome(), ".agents", "skills", name, "SKILL.md");
  const path = (await Bun.file(installed).exists()) ? installed : sharedPath;
  if (change === "remove" || change === "disable") {
    agent.note(`The skill ${name} was ${change === "remove" ? "removed" : "switched off"}: do not use it.`);
  } else {
    const meta = frontmatter(await Bun.file(path).text().catch(() => ""));
    agent.note(`A skill is now available (installed or updated), read its file when a task matches:\n<skill path="${path}" name="${meta.name ?? name}">${meta.description ?? ""}</skill>`);
  }
  return "the model hears of it with your next message";
}

function startupPanel(parts: { context: { path: string }[]; skills: { name: string }[]; extensions: string[]; version: string; profile?: string; face?: string; tagline?: string; integrations?: string }): string {
  // Kinoko itself, with the face of the profile in use; the name beside it.
  const art = mushroomArt(parts.face);
  const mid = Math.max(0, Math.floor(art.length / 2) - 1);
  const beside = [`${ANSI.amanita}kinoko${ANSI.reset} ${ANSI.cream}v${parts.version}${ANSI.reset}`, parts.tagline ? `${ANSI.dim}${parts.tagline.length > 64 ? `${parts.tagline.slice(0, 63)}…` : parts.tagline}${ANSI.reset}` : ""];
  return [
    ...art.map((row, i) => (i >= mid && i < mid + beside.length && beside[i - mid] ? `${row}   ${beside[i - mid]}` : row).trimEnd()),
    "",
    "\x1b[38;5;214m[Capabilities]\x1b[0m",
    `  Profile: ${parts.profile ? `${ANSI.cream}${parts.profile}${ANSI.reset}` : "none (/profile)"}`,
    `  Context: ${names(parts.context.map((file) => basename(file.path)), "none")}`,
    `  Skills: ${names(parts.skills.map((skill) => skill.name), "none")}`,
    `  Extensions: ${names(parts.extensions, "none")}`,
    `  Integrations: ${parts.integrations || "none (/integrations)"}`,
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
    // And this directory's folder, when that session was all it held.
    const folder = dirname(ended.path);
    if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
    return "";
  }
  return `\n${ANSI.dim}resume this session with${ANSI.reset}  ${ANSI.cream}kinoko --session ${ended.meta.id}${ANSI.reset}\n`;
}

function names(items: string[], empty: string): string {
  return items.length === 0 ? empty : items.join(", ");
}
