// What changed in the working tree, for the side panel: every file that differs from HEAD (staged
// or not) with its added and removed lines, plus new files git does not track yet. Read with git,
// asynchronously, each call bounded by the caller's signal: a slow repository never blocks a key.

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** git cannot count lines in it. */
  binary?: boolean;
  /** Not tracked yet: every line is an addition. */
  fresh?: boolean;
}

export type Git = (args: string[], cwd: string, signal: AbortSignal) => Promise<string | undefined>;

/** Runs git; undefined when it fails (not a repository, no HEAD yet, no git at all). */
export const runGit: Git = async (args, cwd, signal) => {
  try {
    const proc = Bun.spawn(["git", "-c", "core.quotepath=off", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", signal });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

/** `git diff --numstat` lines: "added<TAB>removed<TAB>path", "-" for both when binary. */
export function parseNumstat(out: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of out.split("\n")) {
    const [added, removed, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path === "" || added === undefined || removed === undefined) continue;
    if (added === "-") changes.push({ path, added: 0, removed: 0, binary: true });
    else changes.push({ path, added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return changes;
}

/** Lines of a new file; undefined for a binary or a huge one (counting it is not worth a stall). */
async function linesOf(path: string): Promise<number | undefined> {
  const file = Bun.file(path);
  if (file.size > 1_000_000) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Sums the counts of the same path (staged plus unstaged, when there is no HEAD to diff against). */
function merge(lists: FileChange[][]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of lists.flat()) {
    const seen = byPath.get(change.path);
    if (seen === undefined) byPath.set(change.path, { ...change });
    else {
      seen.added += change.added;
      seen.removed += change.removed;
      seen.binary = seen.binary === true || change.binary === true ? true : undefined;
    }
  }
  return [...byPath.values()];
}

/**
 * The working tree against HEAD, new files included, sorted by path; undefined outside a git
 * repository. Paths are relative to the repository root, as git prints them.
 */
export async function gitChanges(cwd: string, signal: AbortSignal, git: Git = runGit): Promise<FileChange[] | undefined> {
  const root = (await git(["rev-parse", "--show-toplevel"], cwd, signal))?.trim();
  if (!root) return undefined;
  const opts = ["--numstat", "--no-renames"];
  const head = await git(["diff", "HEAD", ...opts], root, signal);
  // A repository without a commit has no HEAD: what is staged plus what is not.
  const tracked =
    head !== undefined
      ? parseNumstat(head)
      : merge([parseNumstat((await git(["diff", "--cached", ...opts], root, signal)) ?? ""), parseNumstat((await git(["diff", ...opts], root, signal)) ?? "")]);
  const untracked = ((await git(["ls-files", "--others", "--exclude-standard"], root, signal)) ?? "").split("\n").filter((p) => p !== "");
  const fresh = await Promise.all(
    untracked.map(async (path): Promise<FileChange> => {
      const lines = await linesOf(`${root}/${path}`).catch(() => undefined);
      return lines === undefined ? { path, added: 0, removed: 0, binary: true, fresh: true } : { path, added: lines, removed: 0, fresh: true };
    }),
  );
  return [...tracked, ...fresh].toSorted((a, b) => a.path.localeCompare(b.path));
}
