// The shell the bash tool and background jobs run commands in, and how to stop one with all it
// started. Linux and macOS: sh, in its own process group (a kill reaches the whole group). Windows:
// Git for Windows' bash when it is there (what models write is bash), else PowerShell; a stop
// takes the whole process tree (taskkill /T).

import { dirname, join } from "node:path";

export interface Shell {
  /** What the model is told it is talking to. */
  name: string;
  /** The command line that runs `command` in it. */
  argv: (command: string) => string[];
  /** Its own process group: only where a group can be killed at once (not Windows). */
  detached: boolean;
}

type Which = (program: string) => string | null;

/** Git for Windows' bash: on PATH (but not System32's, which is WSL's), or beside git.exe. */
export function gitBash(which: Which, exists: (path: string) => boolean): string | undefined {
  const onPath = which("bash");
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) return onPath;
  const git = which("git");
  if (git === null) return undefined;
  // git.exe lives in <Git>\cmd or <Git>\bin (or mingw64\bin); bash.exe in <Git>\bin.
  for (const up of ["..", "../.."]) {
    const bash = join(dirname(git), up, "bin", "bash.exe");
    if (exists(bash)) return bash;
  }
  return undefined;
}

export function shellFor(platform: NodeJS.Platform = process.platform, which: Which = (p) => Bun.which(p), exists = (p: string) => Bun.file(p).size > 0): Shell {
  if (platform !== "win32") return { name: "sh (POSIX shell)", argv: (c) => ["sh", "-c", c], detached: true };
  const bash = gitBash(which, exists);
  if (bash) return { name: "bash (Git for Windows)", argv: (c) => [bash, "-c", c], detached: false };
  const ps = which("pwsh") ?? "powershell";
  return { name: "PowerShell (no bash here: write PowerShell commands)", argv: (c) => [ps, "-NoProfile", "-NonInteractive", "-Command", c], detached: false };
}

/** The shell for this computer, found once. */
let found: Shell | undefined;
export const shell = (): Shell => (found ??= shellFor());

/** The user's own shell, for `!command` and /shell: $SHELL on Unix; on Windows the same one the
 *  bash tool uses (Git Bash, else PowerShell). `command` runs in it; none: it is opened. */
export function userShellArgv(command: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, sh: () => Shell = shell): string[] {
  if (platform !== "win32") {
    const own = env.SHELL || "/bin/sh";
    return command ? [own, "-c", command] : [own];
  }
  const argv = sh().argv(command);
  // Interactive: the program alone (bash, or PowerShell without -Command).
  return command ? argv : [argv[0] ?? "powershell"];
}

/** Stops a process and everything it started: its group on Unix, its tree on Windows. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL", platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    } catch {
      // gone already, or no taskkill
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // the group may already be gone
  }
}

/** How the model stops a background job by hand. */
export const stopHint = (pid: number, platform: NodeJS.Platform = process.platform): string => (platform === "win32" ? `taskkill /pid ${pid} /T /F` : `kill -- -${pid}`);

/** Whether something of a command's process group still runs after the command ended (it was put
 *  aside with & or nohup). Unix only: Windows has no groups to ask, so false. */
export function groupAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32" || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What the model is told when a command ended but left processes running on their own. */
export const leftNote = (pid: number, after: string): string =>
  `It left processes running on their own (& or nohup): kinoko does not watch them and nobody is told when they end; ${after}. To stop them: ${stopHint(pid)}. To be told when something ends, run it with background: true, without & or nohup.`;
