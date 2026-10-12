const HARD_MS = 10_000;
const CHUNK_BYTES = 65536;
const HEAD_BYTES = 4096;

export interface SearchQuery {
  pattern: string;
  mode: "content" | "files";
  path: string;
  glob: string;
  context: number;
  hidden: boolean;
  noIgnore: boolean;
  maxTokens: number;
  cwd: string;
  signal: AbortSignal;
}

export interface Hit {
  path: string;
  line: number;
  text: string;
  kind: "match" | "context";
}

export interface FileRow {
  path: string;
  mtimeMs: number;
}

interface LineItem {
  no: number;
  text: string;
}

export interface ScanNote {
  timedOut: boolean;
  error?: string; // why the backend failed, e.g. an invalid pattern from rg
}

export interface Backend {
  kind: "rg" | "bun";
  content: (query: SearchQuery, note: ScanNote) => AsyncGenerator<Hit, void>;
  files: (query: SearchQuery, note: ScanNote) => AsyncGenerator<FileRow, void>;
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
  negate: boolean;
}

function splitLines(text: string): string[] {
  if (text.endsWith("\n")) {
    return text.slice(0, -1).split("\n");
  }
  return text.split("\n");
}

function hasUpper(text: string): boolean {
  return text !== text.toLowerCase();
}

/** smart-case: case-insensitive unless the pattern has an upper-case letter. */
export function smartRegex(pattern: string): null | RegExp {
  try {
    return new RegExp(pattern, hasUpper(pattern) ? "" : "i");
  } catch {
    return null;
  }
}

function trimLine(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** Each file with when it last changed (0 when it is gone), read in parallel: nothing blocks. */
function withMtimes(root: string, rels: string[]): Promise<FileRow[]> {
  return Promise.all(
    rels.map(async (rel) => ({
      path: rel,
      mtimeMs: await Bun.file(`${root}/${rel}`)
        .stat()
        .then((st) => st.mtimeMs)
        .catch(() => 0),
    })),
  );
}

function sortRows(rows: FileRow[]): void {
  rows.sort((a: FileRow, b: FileRow) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs > b.mtimeMs ? -1 : 1;
    }
    return a.path < b.path ? -1 : 1;
  });
}

function asObj(value: unknown): null | Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function eventHit(line: string): null | Hit {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const event = asObj(raw);
  if (event === null) {
    return null;
  }
  const what = event.type;
  let kind: null | "match" | "context";
  if (what === "match") {
    kind = "match";
  } else if (what === "context") {
    kind = "context";
  } else {
    return null;
  }
  const data = asObj(event.data);
  if (data === null) {
    return null;
  }
  const file = asObj(data.path);
  if (file === null) {
    return null;
  }
  const lines = asObj(data.lines);
  if (lines === null) {
    return null;
  }
  const path = file.text;
  const text = lines.text;
  const lineNo = data.line_number;
  if (typeof path !== "string" || typeof text !== "string" || typeof lineNo !== "number") {
    return null;
  }
  return { path: normPath(path), line: lineNo, text: trimLine(text), kind: kind };
}

// ripgrep from PATH, else the pure-Bun scan: nothing is ever downloaded behind the user's back.
let rgCache: undefined | null | string;

function rgExe(): null | string {
  rgCache ??= Bun.which("rg");
  return rgCache;
}

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

/** Yields stdout as it arrives; kills the child on a timeout, an abort, or when the reader stops early. */
async function* pump(child: Child, signal: AbortSignal, note: ScanNote, timeoutMs: number): AsyncGenerator<string, void> {
  const kill = (): void => child.kill("SIGKILL");
  // Its first stderr line is the error to report (a bad glob, a path that is not there).
  const errors = new Response(child.stderr).text().then((text) => {
    if (note.error === undefined && text.trim() !== "") note.error = text.trim().split("\n")[0] ?? "backend failed";
  });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          note.timedOut = true;
          kill();
        }, timeoutMs)
      : null;
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  const decoder = new TextDecoder();
  try {
    for await (const bytes of child.stdout) {
      const text = decoder.decode(bytes, { stream: true });
      if (text !== "") yield text;
    }
    await errors;
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    if (child.exitCode === null) kill();
  }
}

function rgArgs(query: SearchQuery): string[] {
  const args = ["--json", "--smart-case"];
  if (query.context > 0) {
    args.push(`-C${query.context}`);
  }
  if (query.hidden) {
    args.push("--hidden");
  }
  if (query.noIgnore) {
    args.push("--no-ignore");
  }
  if (query.glob !== "") {
    args.push("-g", query.glob);
  }
  args.push("--");
  args.push(query.pattern);
  args.push(".");
  return args;
}

/** A spawn that cannot even start is a scan error, not a crash of the whole tool. */
function start(exe: string, args: string[], query: SearchQuery, note: ScanNote): null | Child {
  try {
    return Bun.spawn([exe, ...args], { cwd: query.path, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    note.error = e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
    return null;
  }
}

async function* rgContent(
  query: SearchQuery,
  note: ScanNote,
  exe: string,
): AsyncGenerator<Hit, void> {
  const child = start(exe, rgArgs(query), query, note);
  if (child === null) {
    return;
  }
  let pending = "";
  for await (const chunk of pump(child, query.signal, note, HARD_MS)) {
    if (query.signal.aborted) {
      return;
    }
    const lines = (pending + chunk).split("\n");
    const tail = lines.pop();
    pending = tail === undefined ? "" : tail;
    for (const line of lines) {
      const hit = eventHit(line);
      if (hit !== null) {
        yield hit;
      }
    }
  }
  if (pending !== "") {
    const hit = eventHit(pending);
    if (hit !== null) {
      yield hit;
    }
  }
}

function rgFileArgs(query: SearchQuery): string[] {
  const args = ["--files"];
  if (query.hidden) {
    args.push("--hidden");
  }
  if (query.noIgnore) {
    args.push("--no-ignore");
  }
  if (query.glob !== "") {
    args.push("-g", query.glob);
  }
  args.push("--");
  args.push(".");
  return args;
}

async function* rgFiles(
  query: SearchQuery,
  note: ScanNote,
  exe: string,
): AsyncGenerator<FileRow, void> {
  const child = start(exe, rgFileArgs(query), query, note);
  if (child === null) {
    return;
  }
  const rels: string[] = [];
  let pending = "";
  for await (const chunk of pump(child, query.signal, note, HARD_MS)) {
    if (query.signal.aborted) {
      return;
    }
    const lines = (pending + chunk).split("\n");
    const tail = lines.pop();
    pending = tail === undefined ? "" : tail;
    for (const line of lines) {
      if (line !== "") rels.push(normPath(line));
    }
  }
  const rows = await withMtimes(query.path, rels);
  sortRows(rows);
  for (const row of rows) {
    yield row;
  }
}

async function readIgnores(root: string): Promise<IgnoreRule[]> {
  let raw: string;
  try {
    raw = await Bun.file(`${root}/.gitignore`).text();
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of splitLines(raw)) {
    const rule = line.trim();
    if (rule === "" || rule.startsWith("#")) {
      continue;
    }
    rules.push(ruleOf(line));
  }
  return rules;
}

function ruleOf(raw: string): IgnoreRule {
  let text = raw;
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  }
  const dirOnly = text.endsWith("/");
  const core = text.replace(/\/$/, "").replace(/^\//, "");
  const anchored = raw.startsWith("/") || core.includes("/");
  const body = globToRe(core);
  const re = anchored ? new RegExp(`^${body}(/.*)?$`) : new RegExp(`(^|/)${body}(/|$)`);
  return { re: re, dirOnly: dirOnly, negate: negate };
}

function globToRe(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) {
      break;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (i < pattern.length && pattern[i] === "*") {
          i++;
        }
        out += ".*";
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (".+()^$|{}[]\\".includes(ch)) {
      out += `\\${ch}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function ignored(rel: string, rules: IgnoreRule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (ruleMatches(rule, rel)) {
      result = !rule.negate;
    }
  }
  return result;
}

function ruleMatches(rule: IgnoreRule, rel: string): boolean {
  if (rule.re.test(rel)) {
    return true;
  }
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (rule.dirOnly && part !== undefined && rule.re.test(part)) {
      return true;
    }
  }
  return false;
}

/** rg prints `./foo`; the Bun glob does not; on Windows both use backslashes. Normalized to `a/b` so
 *  both backends emit the same paths and .gitignore rules (always `/`) match them. */
function normPath(raw: string): string {
  const posix = raw.replaceAll("\\", "/");
  return posix.startsWith("./") ? posix.slice(2) : posix;
}

function hiddenPath(rel: string): boolean {
  for (const part of rel.split("/")) {
    if (part.startsWith(".")) {
      return true;
    }
  }
  return false;
}

/** Streaming line reader for the Bun fallback: chunked reads, never the whole file at once. */
async function* lineScan(
  path: string,
  cursor: number,
  size: number,
  carry: string,
  lineNo: number,
): AsyncGenerator<LineItem, void> {
  if (cursor >= size) {
    if (carry !== "") {
      yield { no: lineNo + 1, text: carry };
    }
    return;
  }
  const take = Math.min(CHUNK_BYTES, size - cursor);
  const raw = await Bun.file(path).slice(cursor, cursor + take).text();
  const parts = (carry + raw).split("\n");
  const tail = parts.pop();
  let no = lineNo;
  for (const text of parts) {
    no = no + 1;
    yield { no: no, text: text };
  }
  yield* lineScan(path, cursor + take, size, tail === undefined ? "" : tail, no);
}

async function* linesOf(path: string): AsyncGenerator<LineItem, void> {
  const file = Bun.file(path);
  const head = await file.slice(0, HEAD_BYTES).text();
  if (head.includes("\u0000")) {
    return;
  }
  yield* lineScan(path, 0, file.size, "", 0);
}

/** Bun.Glob yields "./x" while rg yields "x": normalize so both backends agree. */
const norm = normPath;

async function* bunContent(query: SearchQuery, note: ScanNote): AsyncGenerator<Hit, void> {
  const regex = smartRegex(query.pattern);
  if (regex === null) {
    note.error = `invalid regex pattern: ${query.pattern}`;
    return;
  }
  const rules = query.noIgnore ? [] : await readIgnores(query.path); // no_ignore: every file
  const globber = new Bun.Glob(query.glob === "" ? "**/*" : query.glob);
  try {
    for await (const found of globber.scan({ cwd: query.path })) {
      const rel = norm(found);
      if (query.signal.aborted) {
        return;
      }
      if (ignored(rel, rules) || (!query.hidden && hiddenPath(rel))) {
        continue;
      }
      const abs = `${query.path}/${rel}`;
    let lastMatch = 0;
    let emitted = 0;
    const ring: LineItem[] = [];
    try {
      for await (const item of linesOf(abs)) {
        if (regex.test(item.text)) {
          for (const back of ring) {
            if (back.no > emitted && back.no >= item.no - query.context) {
              yield { path: rel, line: back.no, text: back.text, kind: "context" };
              emitted = back.no;
            }
          }
          yield { path: rel, line: item.no, text: item.text, kind: "match" };
          emitted = item.no;
          lastMatch = item.no;
        } else if (item.no <= lastMatch + query.context && item.no > emitted) {
          yield { path: rel, line: item.no, text: item.text, kind: "context" };
          emitted = item.no;
        }
        ring.push({ no: item.no, text: item.text });
        if (ring.length > query.context) {
          ring.shift();
        }
      }
    } catch {
      // Unreadable file (permissions, or it vanished mid-scan): skip it, keep searching.
    }
    }
  } catch (e) {
    note.error = `scan stopped early: ${e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e)}`;
  }
}

async function* bunFiles(query: SearchQuery, note: ScanNote): AsyncGenerator<FileRow, void> {
  const rels: string[] = [];
  const rules = query.noIgnore ? [] : await readIgnores(query.path); // no_ignore: every file
  const globber = new Bun.Glob(query.glob === "" ? "**/*" : query.glob);
  try {
    for await (const found of globber.scan({ cwd: query.path })) {
      const rel = norm(found);
      if (query.signal.aborted) {
        return;
      }
      if (ignored(rel, rules) || (!query.hidden && hiddenPath(rel))) {
        continue;
      }
      rels.push(rel);
    }
  } catch (e) {
    note.error = `scan stopped early: ${e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e)}`;
  }
  const rows = await withMtimes(query.path, rels);
  sortRows(rows);
  for (const row of rows) {
    yield row;
  }
}

export async function makeBackend(): Promise<Backend> {
  if (process.env.KINOKO_RG_BACKEND === "bun") {
    return { kind: "bun", content: bunContent, files: bunFiles };
  }
  const exe = rgExe();
  if (exe === null) {
    return { kind: "bun", content: bunContent, files: bunFiles };
  }
  return {
    kind: "rg",
    content: (query: SearchQuery, note: ScanNote) => rgContent(query, note, exe),
    files: (query: SearchQuery, note: ScanNote) => rgFiles(query, note, exe),
  };
}
