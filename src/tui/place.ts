// "Where am I", for the line under the editor: the cwd with ~ for home, plus the git branch.
// The branch is read from .git/HEAD directly: no git process, nothing blocks the event loop.

import { dirname, resolve } from "node:path";

/** "~/Projects/kinoko (master)", or just the path outside a repository. */
export async function placeLine(cwd: string, home = process.env.HOME ?? ""): Promise<string> {
  const inHome = home !== "" && (cwd === home || cwd.startsWith(`${home}/`));
  const path = inHome ? `~${cwd.slice(home.length)}` : cwd;
  const branch = await gitBranch(cwd);
  return branch === undefined ? path : `${path} (${branch})`;
}

/** The checked-out branch (or a short sha when detached), walking up from `cwd`. */
export async function gitBranch(cwd: string): Promise<string | undefined> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    // oxlint-disable-next-line no-await-in-loop -- the walk stops at the first repository found
    const head = await readHead(`${dir}/.git`);
    if (head !== undefined) return head;
    if (dirname(dir) === dir) return undefined;
  }
}

async function readHead(git: string): Promise<string | undefined> {
  let gitDir = git;
  const dotGit = Bun.file(git);
  // A worktree or submodule has a .git FILE pointing at the real directory.
  const pointer = await dotGit.text().catch(() => undefined);
  if (pointer?.startsWith("gitdir:")) gitDir = resolve(dirname(git), pointer.slice(7).trim());
  const head = await Bun.file(`${gitDir}/HEAD`).text().catch(() => undefined);
  if (head === undefined) return undefined;
  const ref = head.trim();
  if (ref.startsWith("ref: ")) return ref.slice(5).replace(/^refs\/heads\//, "");
  return ref.slice(0, 7);
}
