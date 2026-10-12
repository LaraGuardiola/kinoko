import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface FileRecord {
  mtimeMs: number;
  /** With the mtime: a change within the clock's grain (Windows) still shows in the size. */
  size: number;
  hash: string;
}

/** One file, one key: Windows paths ignore case (d:\\x is D:\\X). */
const key = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : path);

/** Session-scoped record of files the model has read: path -> state at read time. */
export class Tracker {
  #records = new Map<string, FileRecord>();

  record(path: string, rec: FileRecord): void {
    this.#records.set(key(path), rec);
  }

  get(path: string): FileRecord | undefined {
    return this.#records.get(key(path));
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

/** Records what the model has now seen (or written) of a file. */
export async function remember(path: string, text: string): Promise<void> {
  const st = await stat(path).catch(() => null);
  if (st) tracker.record(path, { mtimeMs: st.mtimeMs, size: st.size, hash: hashOf(text) });
}

/**
 * Read-before-change check: null = OK, string = ERROR message for the model. Same mtime and size
 * mean unchanged, so the file is only read (or `text`, already read by the caller, hashed) when the
 * mtime moved: a touch or a no-op rewrite with identical content still passes.
 */
export async function checkRead(path: string, text?: string): Promise<string | null> {
  const seen = tracker.get(path);
  if (!seen) return "ERROR: you must read this file before changing it — call read first";
  const st = await stat(path).catch(() => null);
  if (!st) return "ERROR: file disappeared since you read it — read it again";
  if (st.mtimeMs === seen.mtimeMs && st.size === seen.size) return null;
  if (hashOf(text ?? (await Bun.file(path).text())) !== seen.hash) {
    return "ERROR: file changed on disk since you read it — read it again before changing it";
  }
  tracker.record(path, { mtimeMs: st.mtimeMs, size: st.size, hash: seen.hash });
  return null;
}
