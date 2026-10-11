// Where an agent can start: the projects kinoko has worked in, newest first, each with its recent
// sessions (to resume one). Read from ~/.kinoko/sessions: one folder per project, one JSONL per
// session, whose first line names the project's directory.

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SessionSummary {
  id: string;
  /** The first thing the user said in it. */
  title: string;
  updated: number;
}

export interface Project {
  cwd: string;
  name: string;
  updated: number;
  sessions: SessionSummary[];
}

/** The head of a session file: its meta line and the first user message, without reading it all. */
async function head(path: string): Promise<{ id?: string; cwd?: string; title: string }> {
  const file = Bun.file(path);
  const text = await file.slice(0, 64 * 1024).text().catch(() => "");
  let id: string | undefined;
  let cwd: string | undefined;
  let title = "";
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line) as { type?: string; meta?: { id?: string; cwd?: string }; message?: { role?: string; content?: string } };
      if (entry.type === "session") ({ id, cwd } = entry.meta ?? {});
      if (entry.type === "message" && entry.message?.role === "user" && !entry.message.content?.startsWith("[kinoko]")) {
        title = (entry.message.content ?? "").split("\n")[0]?.slice(0, 100) ?? "";
        break;
      }
    } catch {
      break; // the slice cut a line: enough read
    }
  }
  return { id, cwd, title };
}

export async function projects(sessionsDir: string, limit = 20, perProject = 8): Promise<Project[]> {
  const dirs = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d): Promise<Project | undefined> => {
      const dir = join(sessionsDir, d.name);
      const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl"));
      const dated = await Promise.all(files.map(async (f) => ({ path: join(dir, f), updated: (await stat(join(dir, f)).catch(() => undefined))?.mtimeMs ?? 0 })));
      const recent = dated.toSorted((a, b) => b.updated - a.updated).slice(0, perProject);
      const heads = await Promise.all(recent.map(async (r) => ({ ...(await head(r.path)), updated: r.updated })));
      const cwd = heads.find((h) => h.cwd)?.cwd;
      if (cwd === undefined) return undefined;
      const sessions = heads.filter((h) => h.id !== undefined && h.title !== "").map((h) => ({ id: h.id ?? "", title: h.title, updated: Math.round(h.updated) }));
      return { cwd, name: basename(cwd), updated: Math.round(recent[0]?.updated ?? 0), sessions };
    }),
  );
  return found.filter((p) => p !== undefined).toSorted((a, b) => b.updated - a.updated).slice(0, limit);
}
