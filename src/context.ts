// Context discovery: project instructions and the skills index.
// Both are read ONCE at session start and then never change, so the prompt prefix stays byte-stable.

import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { readDisabled } from "./disabled.ts";
import { userHome } from "./home.ts";

export interface ContextFile {
  path: string;
  body: string;
}

export interface SkillEntry {
  path: string;
  name: string;
  description: string;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILLS_REL = ".agents/skills";

/**
 * Walks from cwd up to the filesystem root collecting the instruction file of every level,
 * ROOT-FIRST (a root AGENTS.md is more general than a nested one, so it comes first).
 */
export async function discoverContext(cwd: string): Promise<ContextFile[]> {
  const perLevel = await Promise.all(levelsOf(cwd).map(instructionOf));
  return perLevel.filter((f) => f !== undefined).toReversed();
}

/** The one instruction file of a directory: AGENTS.md, else CLAUDE.md. */
async function instructionOf(dir: string): Promise<ContextFile | undefined> {
  const found = await Promise.all(
    INSTRUCTION_FILES.map(async (name) => {
      const path = join(dir, name);
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return { path, body: (await file.text()).trimEnd() };
    }),
  );
  return found.find((f) => f !== undefined);
}

/** Skills from the project first, then the user's; bodies are loaded with the read tool. */
export async function discoverSkills(cwd: string, home?: string): Promise<SkillEntry[]> {
  const base = home ?? userHome();
  // The project's, the user's shared ones, then those installed from /skills (~/.kinoko/skills).
  const roots = [join(cwd, SKILLS_REL), ...(base ? [join(base, SKILLS_REL), join(base, ".kinoko", "skills")] : [])];
  const paths = uniqueDirs(roots).flatMap(skillPathsOf);
  const found = (await Promise.all(paths.map(skillOf))).filter((s) => s !== undefined);
  const seen = new Set<string>();
  const off = new Set(base ? (await readDisabled(base)).skills : []); // switched off in /skills
  return found.filter((s) => !off.has(s.name) && !seen.has(s.name) && seen.add(s.name)); // a project skill shadows a home one
}

/** Directories deduped by real path, first wins: run from $HOME, project and user dirs are one. */
export function uniqueDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const real = realOrResolved(dir);
    return !seen.has(real) && seen.add(real);
  });
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Every `<root>/<name>/SKILL.md` path, sorted, so the index order is stable. */
function skillPathsOf(root: string): string[] {
  try {
    return readdirSync(root)
      .toSorted()
      .map((name) => join(root, name, "SKILL.md"));
  } catch {
    return [];
  }
}

async function skillOf(path: string): Promise<SkillEntry | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const meta = frontmatter(await file.text());
  return { path, name: meta.name ?? basename(dirname(path)), description: meta.description ?? "" };
}

/** Project instructions wrapped one block per file. */
export function renderContext(files: ContextFile[]): string {
  return files.map((f) => `<ctx path="${f.path}">\n${f.body}\n</ctx>`).join("\n\n");
}

/** The skills index: name, path and description only, never the body. */
export function renderSkills(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const rows = skills.map((s) => `<skill path="${s.path}" name="${s.name}">${s.description}</skill>`);
  return `<skills>\n${rows.join("\n")}\n</skills>`;
}

/**
 * The two frontmatter keys we care about; everything else in the YAML is ignored.
 * A value may continue on indented lines (`description: >` / `|` blocks, wrapped plain text):
 * they are joined with spaces, since the index renders each skill on one line.
 */
export function frontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return {};
  const body = lines.slice(1, end);
  const out: { name?: string; description?: string } = {};
  for (const [i, line] of body.entries()) {
    const at = line.indexOf(":");
    if (at < 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, at).trim();
    if (key !== "name" && key !== "description") continue;
    const head = line.slice(at + 1).trim();
    const rest = body.slice(i + 1);
    const stop = rest.findIndex((l) => l.trim() !== "" && !/^\s/.test(l));
    const more = (stop < 0 ? rest : rest.slice(0, stop)).map((l) => l.trim()).filter((l) => l !== "");
    const first = /^[>|][+-]?$/.test(head) ? [] : [unquote(head)]; // block indicator, not text
    out[key] = [...first, ...more].join(" ");
  }
  return out;
}

/** cwd, then every parent up to the root. */
function levelsOf(cwd: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (;;) {
    out.push(dir);
    const parent = parse(dir).dir;
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}