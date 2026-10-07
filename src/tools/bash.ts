import { spawn } from "node:child_process";
import { budget } from "./budget";
import type { Tool, ToolContext } from "../types";

const DEFAULT_MAX_TOKENS = 4000;

interface BashArgs {
  cmd?: unknown;
  timeout?: unknown;
}

/**
 * Runs `sh -c cmd` in its own process group (detached), streams chunks
 * through ctx.onOutput, and kills the WHOLE group on abort or timeout.
 */
async function bashRun(args: BashArgs, ctx: ToolContext): Promise<string> {
  const cmd = args.cmd;
  if (typeof cmd !== "string") return "ERROR: bash: cmd must be a string";
  const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? Math.trunc(args.timeout) : 0;

  const child = spawn("sh", ["-c", cmd], { detached: true, cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid ?? -1;

  const chunks: string[] = [];
  const collect = (b: Buffer): void => {
    const s = b.toString();
    chunks.push(s);
    ctx.onOutput?.(s);
  };
  child.stdout.on("data", (b: Buffer) => collect(b));
  child.stderr.on("data", (b: Buffer) => {
    collect(b);
  });

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
    let timer: null | ReturnType<typeof setTimeout> = null;
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => {
          timedOut = true;
          killGroup();
        },
        timeoutMs,
      );
    }

    const onAbort = (): void => {
      killGroup();
      finish("Aborted by user");
    };
    ctx.signal.addEventListener("abort", onAbort);

    child.on("close", async () => {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const raw = chunks.join("");
      const suffix = timedOut ? `\n[timed out after ${timeoutMs}ms — process group killed]` : "";
      finish(await budget(raw + suffix, { maxTokens: DEFAULT_MAX_TOKENS, id: crypto.randomUUID() }));
    });
  });
}

export const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command (sh -c) in the session cwd. Output is budgeted; on user abort or timeout the whole process group is killed.",
  schema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "shell command" },
      timeout: { type: "number", description: "kill after N ms" },
    },
    required: ["cmd"],
  },
  run: bashRun,
};
