import { describe, expect, test } from "bun:test";
import { gitBash, shellFor, stopHint, userShellArgv } from "../shell.ts";

const which = (paths: Record<string, string>) => (program: string): string | null => paths[program] ?? null;
const none = (): boolean => false;
/** A Windows without Git: PowerShell. */
const ps = (): ReturnType<typeof shellFor> => shellFor("win32", which({}), none);

describe("the shell commands run in", () => {
  test("Linux and macOS: sh, in its own process group", () => {
    const sh = shellFor("linux", which({}));
    expect(sh.argv("ls -la")).toEqual(["sh", "-c", "ls -la"]);
    expect(sh.detached).toBe(true);
    expect(shellFor("darwin", which({})).name).toContain("sh");
  });

  test("Windows: Git for Windows' bash (not System32's, which is WSL), found on PATH or beside git.exe", () => {
    expect(gitBash(which({ bash: "C:\\Program Files\\Git\\bin\\bash.exe" }), none)).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(gitBash(which({ bash: "C:\\Windows\\System32\\bash.exe" }), none)).toBeUndefined();
    const beside = gitBash(which({ bash: "C:\\Windows\\System32\\bash.exe", git: "/Git/cmd/git.exe" }), (p) => p.endsWith("bin/bash.exe") || p.endsWith("bin\\bash.exe"));
    expect(beside?.replaceAll("\\", "/")).toBe("/Git/bin/bash.exe");
    const sh = shellFor("win32", which({ bash: "C:\\Git\\bin\\bash.exe" }), none);
    expect(sh.name).toBe("bash (Git for Windows)");
    expect(sh.argv("ls")).toEqual(["C:\\Git\\bin\\bash.exe", "-c", "ls"]);
    expect(sh.detached).toBe(false);
  });

  test("Windows without Git: PowerShell, and the model is told", () => {
    const pwsh = shellFor("win32", which({ pwsh: "C:\\pwsh.exe" }), none);
    expect(pwsh.argv("Get-ChildItem")).toEqual(["C:\\pwsh.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"]);
    expect(pwsh.name).toContain("write PowerShell commands");
    expect(shellFor("win32", which({}), none).argv("x")[0]).toBe("powershell");
  });

  test("!command and /shell: $SHELL on Unix; on Windows the tool's shell, opened alone when interactive", () => {
    expect(userShellArgv("make", { SHELL: "/bin/zsh" }, "linux")).toEqual(["/bin/zsh", "-c", "make"]);
    expect(userShellArgv("", {}, "linux")).toEqual(["/bin/sh"]);
    expect(userShellArgv("dir", {}, "win32", ps)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command", "dir"]);
    expect(userShellArgv("", {}, "win32", ps)).toEqual(["powershell"]);
  });

  test("how the model stops a background job by hand", () => {
    expect(stopHint(42, "linux")).toBe("kill -- -42");
    expect(stopHint(42, "win32")).toBe("taskkill /pid 42 /T /F");
  });
});
