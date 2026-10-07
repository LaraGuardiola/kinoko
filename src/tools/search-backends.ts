import { spawn } from "node:child_process";
import { accessSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { ChildProcess } from "node:child_process";

const HARD_MS = 10_000;
const CHUNK_BYTES = 65536;
const HEAD_BYTES = 4096;

const PIN_URL: Record<string, string> = {
  x64: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
  arm64: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
};

const PIN_SHA: Record<string, string> = {
  x64: "f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7",
  arm64: "e07d5c85fa9ca740ff4ab8bbac60a1e11c7a5ce242435f7820a03f7c20ef6276",
};

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

function isExec(file: string): boolean {
  try {
    accessSync(file, 1);
    return true;
  } catch {
    return false;
  }
}

function rgOnPath(): null | string {
  const env = process.env.PATH;
  if (env === undefined) {
    return null;
  }
  for (const entry of env.split(":")) {
    const candidate = entry === "" ? `${process.cwd()}/rg` : `${entry}/rg`;
    if (isExec(candidate)) {
      return candidate;
    }
  }
  return null;
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
function smartRegex(pattern: string): null | RegExp {
  try {
    return new RegExp(pattern, hasUpper(pattern) ? "" : "i");
  } catch {
    return null;
  }
}

function trimLine(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
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

function octalField(bytes: Uint8Array): number {
  const digits = new TextDecoder().decode(bytes).replace(/[^0-7]/g, "");
  return parseInt(digits === "" ? "0" : digits, 8);
}

function untar(bytes: Uint8Array, want: string): null | Uint8Array {
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const decoded = new TextDecoder().decode(bytes.subarray(offset, offset + 100));
    const nul = decoded.indexOf("\u0000");
    const name = nul === -1 ? decoded : decoded.slice(0, nul);
    const size = octalField(bytes.subarray(offset + 124, offset + 136));
    const body = offset + 512;
    if (name === want || name.endsWith(`/${want}`)) {
      return bytes.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

function exitOk(code: null | number): boolean {
  return code === null ? false : code === 0;
}

function runsRg(exe: string): Promise<boolean> {
  const child = spawn(exe, ["--version"], { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise<boolean>((done) => {
    child.on("close", (code: null | number) => {
      done(exitOk(code));
    });
  });
}

/** A pinned ripgrep, downloaded at most once into ~/.kinoko/bin. Any failure -> null (fall through). */
async function pinnedRg(): Promise<null | string> {
  const exe = `${homedir()}/.kinoko/bin/rg`;
  if (isExec(exe)) {
    return exe;
  }
  const url = process.env.KINOKO_RG_URL ?? PIN_URL[process.arch];
  const want = PIN_SHA[process.arch];
  if (url === undefined || want === undefined) {
    return null;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const packed = new Uint8Array(await res.arrayBuffer());
    const tar = Bun.gunzipSync(packed);
    const rg = untar(tar, "rg");
    if (rg === null) {
      return null;
    }
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rg);
    if (hasher.digest("hex") !== want) {
      return null;
    }
    mkdirSync(`${homedir()}/.kinoko/bin`, { recursive: true });
    await Bun.write(exe, rg);
    chmodSync(exe, 0o755);
    if (!await runsRg(exe)) {
      return null;
    }
    return exe;
  } catch {
    return null;
  }
}

let rgCache: undefined | null | string;

async function rgExe(): Promise<null | string> {
  if (rgCache !== undefined) {
    return rgCache;
  }
  const found = rgOnPath();
  if (found !== null) {
    rgCache = found;
    return rgCache;
  }
  rgCache = await pinnedRg();
  return rgCache;
}

/** Event-driven stdout pump: yields stdout chunks as they arrive, kills the child on early exit. */
async function* pump(
  child: ChildProcess,
  signal: AbortSignal,
  note: ScanNote,
  timeoutMs: number,
): AsyncGenerator<string, void> {
  const parts: string[] = [];
  let wake: null | (() => void) = null;
  let ended = false;
  let timer: null | ReturnType<typeof setTimeout> = null;

  const wakeUp = (): void => {
    const waiting = wake;
    wake = null;
    if (waiting !== null) {
      waiting();
    }
  };

  const wait = (): Promise<void> =>
    new Promise<void>((done) => {
      wake = (): void => {
        wake = null;
        done();
      };
    });

  const kill = (): void => {
    child.kill("SIGKILL");
  };

  const out = child.stdout;
  if (out !== null) {
    out.on("data", (chunk: Buffer) => {
      parts.push(chunk.toString());
      wakeUp();
    });
  }
  child.on("close", () => {
    ended = true;
    wakeUp();
  });
  child.on("error", () => {
    ended = true;
    wakeUp();
  });

  if (timeoutMs > 0) {
    timer = setTimeout(
      () => {
        note.timedOut = true;
        kill();
      },
      timeoutMs,
    );
  }

  const onAbort = (): void => {
    kill();
  };
  if (signal.aborted) {
    kill();
  } else {
    signal.addEventListener("abort", onAbort);
  }

  const drain = async function* (): AsyncGenerator<string, void> {
    if (parts.length > 0) {
      const chunk = parts.shift();
      if (chunk !== undefined) {
        yield chunk;
      }
      yield* drain();
      return;
    }
    if (ended) {
      return;
    }
    await wait();
    yield* drain();
  };

  try {
    yield* drain();
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    signal.removeEventListener("abort", onAbort);
    if (!ended) {
      kill();
    }
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

async function* rgContent(
  query: SearchQuery,
  note: ScanNote,
  exe: string,
): AsyncGenerator<Hit, void> {
  const child = spawn(exe, rgArgs(query), { cwd: query.path, stdio: ["pipe", "pipe", "pipe"] });
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
  const child = spawn(exe, rgFileArgs(query), { cwd: query.path, stdio: ["pipe", "pipe", "pipe"] });
  const rows: FileRow[] = [];
  let pending = "";
  for await (const chunk of pump(child, query.signal, note, HARD_MS)) {
    if (query.signal.aborted) {
      return;
    }
    const lines = (pending + chunk).split("\n");
    const tail = lines.pop();
    pending = tail === undefined ? "" : tail;
    for (const line of lines) {
      if (line !== "") {
        const rel = normPath(line);
        rows.push({ path: rel, mtimeMs: mtimeMs(`${query.path}/${rel}`) });
      }
    }
  }
  sortRows(rows);
  for (const row of rows) {
    yield row;
  }
}

function readIgnores(root: string): IgnoreRule[] {
  let raw: string;
  try {
    raw = readFileSync(`${root}/.gitignore`, "utf8");
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

/** rg prints `./foo`; the Bun glob does not. Normalize so both backends emit the same paths. */
function normPath(raw: string): string {
  return raw.startsWith("./") ? raw.slice(2) : raw;
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
function norm(rel: string): string {
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

async function* bunContent(query: SearchQuery, _note: ScanNote): AsyncGenerator<Hit, void> {
  const regex = smartRegex(query.pattern);
  if (regex === null) {
    return;
  }
  const rules = readIgnores(query.path);
  const globber = new Bun.Glob(query.glob === "" ? "**/*" : query.glob);
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
  }
}

async function* bunFiles(query: SearchQuery, _note: ScanNote): AsyncGenerator<FileRow, void> {
  const rows: FileRow[] = [];
  const rules = readIgnores(query.path);
  const globber = new Bun.Glob(query.glob === "" ? "**/*" : query.glob);
  for await (const found of globber.scan({ cwd: query.path })) {
    const rel = norm(found);
    if (query.signal.aborted) {
      return;
    }
    if (ignored(rel, rules) || (!query.hidden && hiddenPath(rel))) {
      continue;
    }
    rows.push({ path: rel, mtimeMs: mtimeMs(`${query.path}/${rel}`) });
  }
  sortRows(rows);
  for (const row of rows) {
    yield row;
  }
}

export async function makeBackend(): Promise<Backend> {
  if (process.env.KINOKO_RG_BACKEND === "bun") {
    return { kind: "bun", content: bunContent, files: bunFiles };
  }
  const exe = await rgExe();
  if (exe === null) {
    return { kind: "bun", content: bunContent, files: bunFiles };
  }
  return {
    kind: "rg",
    content: (query: SearchQuery, note: ScanNote) => rgContent(query, note, exe),
    files: (query: SearchQuery, note: ScanNote) => rgFiles(query, note, exe),
  };
}
