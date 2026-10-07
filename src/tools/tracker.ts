import { statSync, readFileSync } from "node:fs";

export interface FileRecord {
  mtimeMs: number;
  hash: string;
}

/** Session-scoped record of files the model has read: path -> state at read time. */
export class Tracker {
  #records = new Map<string, FileRecord>();

  record(path: string, rec: FileRecord): void {
    this.#records.set(path, rec);
  }

  get(path: string): FileRecord | undefined {
    return this.#records.get(path);
  }

  reset(): void {
    this.#records.clear();
  }
}

/** The tracker shared by the read/write/edit tools. Call reset() per session. */
export const tracker = new Tracker();

export function hashOf(content: string): string {
  return Bun.hash(content).toString(36);
}

/** Current on-disk state of a file (null if missing). */
export function readState(path: string): FileRecord | null {
  try {
    const st = statSync(path);
    const text = readFileSync(path, "utf8");
    return { mtimeMs: st.mtimeMs, hash: hashOf(text) };
  } catch {
    return null;
  }
}

/** Snapshot from content already in memory (avoids re-reading). */
export function stateOf(path: string, text: string): FileRecord | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, hash: hashOf(text) };
  } catch {
    return null;
  }
}

/** Read-before-change check: null = OK, string = ERROR message for the model. */
export function checkRead(path: string): string | null {
  const seen = tracker.get(path);
  if (!seen) return "ERROR: you must read this file before changing it — call read first";
  const cur = readState(path);
  if (!cur) return "ERROR: file disappeared since you read it — read it again";
  if (cur.mtimeMs !== seen.mtimeMs || cur.hash !== seen.hash) {
    return "ERROR: file changed on disk since you read it — read it again before changing it";
  }
  return null;
}
