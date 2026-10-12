// The user's home folder, where ~/.kinoko lives: HOME when set (Linux, macOS, Git Bash; tests point it
// at a sandbox), else USERPROFILE (Windows), else what the system says.

import { homedir } from "node:os";

export function userHome(env: Record<string, string | undefined> = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}
