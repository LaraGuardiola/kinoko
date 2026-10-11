import { spawn } from "node:child_process";
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
 * Runs `sh -c cmd` in its own process group (detached), streams chunks
 * through ctx.onOutput, and kills the WHOLE group on abort or timeout.
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
      `Its output: ${job.log}. To stop it: kill -- -${job.pid}`,
    ].join("\n");
  }
  const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? Math.trunc(args.timeout) : DEFAULT_TIMEOUT_MS;

  // No stdin: a command waiting for input would otherwise wait forever.
  const child = spawn("sh", ["-c", cmd], { detached: true, cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid ?? -1;

  const chunks: string[] = [];
  const collect = (s: string): void => {
    chunks.push(s);
    ctx.onOutput?.(s);
  };
  // utf8 decoding per stream: a multi-byte character split across two chunks stays whole.
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);

  const killGroup = (): void => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // group may already be gone
    }
  };

  if (ctx.signal.aborted) {
    killGroup();
    return "Aborted by user";
  }

  return new Promise<string>((resolve) => {
    const finish = (value: string): void => resolve(value);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = (): void => {
      killGroup();
      finish("Aborted by user");
    };
    ctx.signal.addEventListener("abort", onAbort);

    child.on("close", async (code: number | null) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const raw = chunks.join("");
      // A failed command says so at the end, where the budget's head+tail always keeps it.
      const exit = code !== null && code !== 0 ? `\n[exit code ${code}]` : "";
      const suffix = timedOut ? `\n[timed out after ${timeoutMs}ms — process group killed]` : exit;
      finish(await budget(raw + suffix, { maxTokens: DEFAULT_MAX_TOKENS, id: crypto.randomUUID() }));
    });
  });
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
