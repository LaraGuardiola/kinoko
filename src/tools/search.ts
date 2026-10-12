import { estimateTokens } from "./budget";
import { makeBackend, smartRegex } from "./search-backends";
import { resolve } from "node:path";
import type { Tool, ToolContext } from "../types";
import type { Backend, Hit, ScanNote, SearchQuery } from "./search-backends";

const DEFAULT_MAX_TOKENS = 2000;
const MAX_LINE = 160;

interface SearchArgs {
  pattern?: unknown;
  mode?: unknown;
  path?: unknown;
  glob?: unknown;
  context?: unknown;
  max_tokens?: unknown;
  hidden?: unknown;
  no_ignore?: unknown;
}

function numArg(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? Math.trunc(value) : fallback;
}

function boolArg(value: unknown): boolean {
  return value === true;
}

function queryOf(args: SearchArgs, path: string, signal: AbortSignal): SearchQuery {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const cwd = path;
  const mode = args.mode === "files" ? "files" : "content";
  const rawGlob = typeof args.glob === "string" ? args.glob : mode === "files" ? pattern : "";
  const glob = globOf(rawGlob);
  return {
    pattern: pattern,
    mode: mode,
    path: path,
    glob: glob,
    context: numArg(args.context, 0),
    hidden: boolArg(args.hidden),
    noIgnore: boolArg(args.no_ignore),
    maxTokens: Math.max(64, numArg(args.max_tokens, DEFAULT_MAX_TOKENS)),
    cwd: cwd,
    signal: signal,
  };
}

/** One glob string for both backends: bare `*.txt` must match nested files too. */
function globOf(raw: string): string {
  if (raw === "" || raw.includes("/") || raw.startsWith("**")) {
    return raw;
  }
  return `**/${raw}`;
}

interface Row {
  path: string;
  hits: Hit[];
  mtimeMs: number;
}

/** When a file last changed (0 when it is gone): read without blocking. */
function mtimeMs(file: string): Promise<number> {
  return Bun.file(file)
    .stat()
    .then((st) => st.mtimeMs)
    .catch(() => 0);
}

function trimAround(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\u2026${text.slice(text.length - half)}`;
}

/** Content mode: stream hits, stop the moment the token budget is reached (kills the backend). */
async function contentText(backend: Backend, query: SearchQuery): Promise<string> {
  const note: ScanNote = { timedOut: false };
  const maxTokens = query.maxTokens;
  const rows: Record<string, Row> = {};
  const order: string[] = [];
  let used = 0;
  let matches = 0;
  let truncated = false;

  for await (const hit of backend.content(query, note)) {
    if (query.signal.aborted) {
      return "Aborted by user";
    }
    const text = trimAround(hit.text, MAX_LINE);
    const cost = estimateTokens(`${hit.path}:${hit.line}: ${text}`);
    if (used + cost > maxTokens) {
      truncated = true;
      break;
    }
    used = used + cost;
    const hit2 = { path: hit.path, line: hit.line, text: text, kind: hit.kind };
    const row = rows[hit.path];
    if (row === undefined) {
      const fresh: Row = { path: hit.path, hits: [hit2], mtimeMs: 0 };
      rows[hit.path] = fresh;
      order.push(hit.path);
    } else {
      row.hits.push(hit2);
    }
    if (hit.kind === "match") {
      matches = matches + 1;
    }
  }

  if (query.signal.aborted) {
    return "Aborted by user";
  }
  // When each file last changed, all at once: the newest first among equal hit counts.
  await Promise.all(order.map(async (p) => ((rows[p] as Row).mtimeMs = await mtimeMs(`${query.path}/${p}`))));

  order.sort((a: string, b: string) => {
    const aRow = rows[a];
    const bRow = rows[b];
    if (aRow === undefined || bRow === undefined) {
      return a < b ? -1 : 1;
    }
    if (aRow.hits.length !== bRow.hits.length) {
      return aRow.hits.length > bRow.hits.length ? -1 : 1;
    }
    if (aRow.mtimeMs !== bRow.mtimeMs) {
      return aRow.mtimeMs > bRow.mtimeMs ? -1 : 1;
    }
    return a < b ? -1 : 1;
  });

  const out: string[] = [];
  for (const path of order) {
    const row = rows[path];
    if (row === undefined) {
      continue;
    }
    out.push(row.path);
    for (const hit of row.hits) {
      const mark = hit.kind === "context" ? "-" : ":";
      out.push(`${hit.line}${mark} ${hit.text}`);
    }
  }
  if (truncated) {
    out.push(`[budget reached after ${matches} matches \u2014 narrow with \`path\`, \`glob\`, or a more specific pattern]`);
  } else if (order.length === 0) {
    out.push(`[no matches for \`${query.pattern}\` in ${query.path}]`);
  }
  if (note.timedOut) {
    out.push("[search timed out after 10s]");
  }
  if (note.error !== undefined) {
    out.push(`ERROR: search failed: ${note.error}`);
  }
  return out.join("\n");
}

async function filesText(backend: Backend, query: SearchQuery): Promise<string> {
  const note: ScanNote = { timedOut: false };
  const maxTokens = query.maxTokens;
  const paths: string[] = [];
  let used = 0;
  let truncated = false;

  for await (const row of backend.files(query, note)) {
    if (query.signal.aborted) {
      return "Aborted by user";
    }
    const cost = estimateTokens(row.path);
    if (used + cost > maxTokens) {
      truncated = true;
      break;
    }
    used = used + cost;
    paths.push(row.path);
  }
  if (query.signal.aborted) {
    return "Aborted by user";
  }
  if (truncated) {
    paths.push(`[budget reached: more files remain \u2014 narrow with \`glob\` or a narrower \`path\`]`);
  } else if (paths.length === 0) {
    paths.push(noFilesMatch(query));
  }
  if (note.timedOut) {
    paths.push("[search timed out after 10s]");
  }
  if (note.error !== undefined) {
    paths.push(`ERROR: search failed: ${note.error}`);
  }
  return paths.join("\n");
}

/**
 * An empty file list is where a model gets stuck: it repeats the same call. Say what was looked
 * for, and point at the mode that would actually search inside files.
 */
function noFilesMatch(query: SearchQuery): string {
  // The raw pattern, not the normalized glob: `**/` is added by us and would look like a glob.
  if (!looksLikeGlob(query.pattern)) {
    return `[no files whose NAME matches \`${query.pattern}\` in ${query.path} \u2014 in files mode \`pattern\` is a glob; to search inside files use mode "content"]`;
  }
  return `[no files matching \`${query.pattern}\` in ${query.path}]`;
}

function looksLikeGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/** Everything cheap that can refuse the request before a backend is started. */
async function validate(args: SearchArgs, ctx: ToolContext): Promise<null | string> {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || pattern === "") {
    return "ERROR: search: pattern must be a non-empty string";
  }
  const mode = args.mode === "files" ? "files" : "content";
  if (mode === "content" && smartRegex(pattern) === null) {
    return `ERROR: search: invalid regex pattern ${JSON.stringify(pattern)}`;
  }
  const raw = typeof args.path === "string" && args.path !== "" ? args.path : ".";
  // resolve() keeps absolute paths and `..` working, instead of gluing them onto the cwd.
  const path = resolve(ctx.cwd, raw);
  const dir = await Bun.file(path)
    .stat()
    .then((st) => st.isDirectory())
    .catch(() => undefined);
  if (dir === undefined) return `ERROR: search: path not found: ${raw}`;
  if (!dir) {
    return `ERROR: search: not a directory: ${raw} (search walks a directory tree)`;
  }
  return null;
}

async function searchRun(args: SearchArgs, ctx: ToolContext): Promise<string> {
  const refused = await validate(args, ctx);
  if (refused !== null) {
    return refused;
  }
  const raw = typeof args.path === "string" && args.path !== "" ? args.path : ".";
  const query = queryOf(args, resolve(ctx.cwd, raw), ctx.signal);
  const backend = await makeBackend();
  try {
    return query.mode === "files" ? await filesText(backend, query) : await contentText(backend, query);
  } catch (e) {
    // A tool never crashes the loop, but it should also never hand back an empty string.
    return `ERROR: search failed: ${e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e)}`;
  }
}

export const searchTool: Tool = {
  name: "search",
  description: "Search file contents (mode content) or list files (mode files). One tool replaces grep+glob+find: smart-case, .gitignore-aware, token-budgeted with early kill. Returns path + `line: text` per hit, files ranked by match count then mtime.",
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "regex pattern (in files mode it is a glob)" },
      mode: { type: "string", enum: ["content", "files"] },
      path: { type: "string", description: "dir/file to search (default: cwd)" },
      glob: { type: "string", description: "only match files against this glob" },
      context: { type: "number", description: "N context lines around each match" },
      max_tokens: { type: "number", description: "output budget in estimated tokens (default 2000)" },
      hidden: { type: "boolean", description: "include dotfiles" },
      no_ignore: { type: "boolean", description: "do not respect .gitignore" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  run: searchRun,
};
