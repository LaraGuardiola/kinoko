import { killTree, shell, stopHint } from "../shell";
import { budget } from "./budget";
import type { Tool, ToolContext } from "../types";

const DEFAULT_MAX_TOKENS = 4000;
/** A command that never ends (a dev server, a prompt for input) must not hang the run forever. */
const DEFAULT_TIMEOUT_MS = 300_000;

interface BashArgs {
  command?: unknown;
  cmd?: unknown; // accepted too: the name used before
  timeout?: unknown;
  background?: unknown;
}

/**
 * Runs the command in this computer's shell (shell.ts: sh in its own process group; on Windows Git
 * Bash or PowerShell), streams chunks through ctx.onOutput, and kills the WHOLE group (Windows: the
 * process tree) on abort or timeout.
 */
async function bashRun(args: BashArgs, ctx: ToolContext): Promise<string> {
  // `command` is what models expect (most harnesses use it).
  const cmd = args.command ?? args.cmd;
  if (typeof cmd !== "string") return "ERROR: bash: missing command (string)";
  if (args.background === true) {
    if (ctx.background === undefined) return "ERROR: bash: background jobs only run in kinoko's interactive and rpc modes";
    const job = ctx.background(cmd);
    return [
      `started background job #${job.id} (pid ${job.pid}): ${cmd}`,
      "Do not wait for it: no wait, sleep, tail or polling (wait does not work on it). Do other work, or end your reply now.",
      "When it ends, kinoko sends you a message with its exit code and last lines: do what comes after it then.",
      `Its output: ${job.log}. To stop it: ${stopHint(job.pid)}`,
    ].join("\n");
  }
  const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? Math.trunc(args.timeout) : DEFAULT_TIMEOUT_MS;

  // No stdin: a command waiting for input would otherwise wait forever. Its own process group
  // (detached), so a kill reaches whatever it started too.
  let child;
  const sh = shell();
  try {
    child = Bun.spawn(sh.argv(cmd), { detached: sh.detached, cwd: ctx.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return `ERROR: bash: could not start ${sh.name}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const pid = child.pid;

  const chunks: string[] = [];
  // utf8 decoding per stream: a multi-byte character split across two chunks stays whole.
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      const s = decoder.decode(bytes, { stream: true });
      if (s === "") continue;
      chunks.push(s);
      ctx.onOutput?.(s);
    }
  };
  const drained = Promise.all([read(child.stdout), read(child.stderr)]).catch(() => undefined);

  const killGroup = (): void => killTree(pid);

  if (ctx.signal.aborted) {
    killGroup();
    return "Aborted by user";
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  // Esc answers at once: the group is killed, and the run does not wait for its pipes to close.
  const aborted = Promise.withResolvers<"aborted">();
  const onAbort = (): void => {
    killGroup();
    aborted.resolve("aborted");
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const ended = await Promise.race([Promise.all([child.exited, drained]).then(() => "ended" as const), aborted.promise]);
  clearTimeout(timer);
  ctx.signal.removeEventListener("abort", onAbort);
  if (ended === "aborted") return "Aborted by user";

  // A signal (the timeout's kill) leaves no exit code, as a normal end of 0 adds nothing.
  const code = child.exitCode;
  const exit = code !== null && code !== 0 ? `\n[exit code ${code}]` : "";
  const suffix = timedOut ? `\n[timed out after ${timeoutMs}ms — process group killed]` : exit;
  return budget(chunks.join("") + suffix, { maxTokens: DEFAULT_MAX_TOKENS, id: crypto.randomUUID() });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command (sh -c) in the session cwd. Output is budgeted; on user abort or timeout the whole process group is killed. background: true starts a long command (a download, a build, a server, waiting for something) as a job and returns at once; you get a message when it ends, so never wait or poll for it.",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command" },
      timeout: { type: "number", description: `kill after N ms (default ${DEFAULT_TIMEOUT_MS})` },
      background: { type: "boolean", description: "run it as a background job: return at once, be told when it ends" },
    },
    required: ["command"],
  },
  run: bashRun,
};
