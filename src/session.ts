// Append-only session log: ~/.kinoko/sessions/<project-hash>/<id>.jsonl
//
// One JSON record per line. Nothing is ever rewritten or deleted, so the file is the
// full history including compactions; the branch that the model actually sees is
// derived from the last compaction record. Forking later is just appending a new
// `head` record.

import { appendFile, mkdir } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashOf } from "./tools/tracker.ts";
import type { Message } from "./types.ts";

export interface SessionMeta {
  id: string;
  created: number;
  cwd: string;
  model: string;
}

type Record =
  | { type: "session"; meta: SessionMeta }
  | { type: "message"; message: Message }
  | { type: "head"; id: string }
  | { type: "compaction"; summary: string; keepFrom: string }
  | ({ type: "model" } & SessionModel);

/** The model a session switched to (the models menu), so a resume picks up where it was. */
export interface SessionModel {
  model: string;
  baseUrl: string;
  contextWindow?: number;
}

export interface SessionOptions {
  cwd: string;
  model: string;
  home?: string;
}

function homeOf(home?: string): string {
  return home ?? process.env.HOME ?? "";
}

/** Directory holding this project's sessions (hashed by cwd). */
export function sessionDir(cwd: string, home?: string): string {
  return join(homeOf(home), ".kinoko", "sessions", hashOf(cwd));
}

/** Newest session file for this project (--continue), or undefined when there is none. */
export function latestSession(cwd: string, home?: string): string | undefined {
  const dir = sessionDir(cwd, home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path;
}

/**
 * The session file for `id` in this directory's sessions: the exact id, or a prefix only one
 * session starts with. Sessions are per directory: an id from another project is not found here.
 */
export function findSession(cwd: string, id: string, home?: string): string | undefined {
  const dir = sessionDir(cwd, home);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  const want = id.trim().replace(/\.jsonl$/, "");
  if (want === "") return undefined;
  const exact = names.find((name) => name === `${want}.jsonl`);
  const matches = exact ? [exact] : names.filter((name) => name.startsWith(want));
  return matches.length === 1 ? join(dir, matches[0]!) : undefined;
}

function parseRecords(text: string): Record[] {
  const out: Record[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Record);
    } catch {
      // A half-written last line (killed process): everything before it still counts.
    }
  }
  return out;
}

export class Session {
  readonly path: string;
  readonly meta: SessionMeta;
  #byId = new Map<string, Message>();
  #log: Message[] = []; // append order, the whole history
  #head: string | undefined;
  #compaction: { summary: string; keepFrom: string } | undefined;
  #model: SessionModel | undefined;
  #compactions = 0;

  private constructor(path: string, meta: SessionMeta) {
    this.path = path;
    this.meta = meta;
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const meta: SessionMeta = { id: crypto.randomUUID(), created: Date.now(), cwd: opts.cwd, model: opts.model };
    const dir = sessionDir(opts.cwd, opts.home);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${meta.id}.jsonl`);
    const session = new Session(path, meta);
    await session.#write({ type: "session", meta });
    return session;
  }

  static async load(path: string): Promise<Session> {
    const records = parseRecords(await Bun.file(path).text());
    const first = records[0];
    if (!first || first.type !== "session") throw new Error(`not a kinoko session: ${path}`);
    const session = new Session(path, first.meta);
    for (const record of records) session.#absorb(record);
    return session;
  }

  /** Appends a finalized message, giving it a parentId when it has none. */
  async append(message: Message): Promise<Message> {
    const stored = message.parentId ? message : { ...message, parentId: this.#log.at(-1)?.id };
    await this.#write({ type: "message", message: stored });
    return stored;
  }

  /** Records a compaction: the summary joins the log, `keepFrom` marks the verbatim tail. */
  async markCompaction(summary: Message, keepFrom: string): Promise<Message> {
    const stored = summary.parentId ? summary : { ...summary, parentId: this.#log.at(-1)?.id };
    await this.#write({ type: "message", message: stored });
    await this.#write({ type: "compaction", summary: stored.id, keepFrom });
    this.#compaction = { summary: stored.id, keepFrom };
    return stored;
  }

  /** Moves the head pointer: the branch that `activeBranch` walks changes, nothing else. */
  async setHead(id: string): Promise<void> {
    // Visible immediately, even though the record is still being appended.
    this.#head = id;
    await this.#write({ type: "head", id });
  }

  /** Records a model switch; the last one is what a resume starts with. */
  async setModel(model: SessionModel): Promise<void> {
    await this.#write({ type: "model", ...model });
  }

  /** The last model switched to; undefined when the session kept the one it started with. */
  get model(): SessionModel | undefined {
    return this.#model;
  }

  /** Every message ever appended, in order: what a session cost, compacted parts and forks included. */
  get history(): readonly Message[] {
    return this.#log;
  }

  /** How many times the history was summarized. */
  get compactions(): number {
    return this.#compactions;
  }

  /** Nothing was ever said in it: not worth keeping, nor offering to resume. */
  get empty(): boolean {
    return this.#log.length === 0;
  }

  /** Root-first messages from the head back to the first message, following parentId. */
  activeBranch(): Message[] {
    const out: Message[] = [];
    let id = this.#head;
    while (id !== undefined) {
      const message = this.#byId.get(id);
      if (!message) break;
      out.push(message);
      id = message.parentId;
    }
    return out.toReversed();
  }

  /** What the model should see: the summary plus the verbatim tail after the last compaction. */
  view(): Message[] {
    const compaction = this.#compaction;
    const head = this.activeBranch();
    if (!compaction) return head;
    const summary = this.#byId.get(compaction.summary);
    const from = this.#log.findIndex((m) => m.id === compaction.keepFrom);
    const to = this.#log.findIndex((m) => m.id === compaction.summary);
    if (!summary || from < 0 || to < from) return head;
    // The tail's replayed thinking and usage belong to the history before the summary (compact.ts).
    return [summary, ...this.#log.slice(from, to).map(({ replay: _replay, usage: _usage, ...m }) => m)];
  }

  /** One append per record: O_APPEND, so a resumed session can never rewrite earlier lines. */
  async #write(record: Record): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.#absorb(record);
  }

  #absorb(record: Record): void {
    if (record.type === "message") {
      this.#byId.set(record.message.id, record.message);
      this.#log.push(record.message);
      this.#head = record.message.id;
    } else if (record.type === "head") {
      this.#head = record.id;
    } else if (record.type === "compaction") {
      this.#compaction = { summary: record.summary, keepFrom: record.keepFrom };
      this.#compactions++;
    } else if (record.type === "model") {
      const { type: _type, ...model } = record;
      this.#model = model;
    }
  }
}