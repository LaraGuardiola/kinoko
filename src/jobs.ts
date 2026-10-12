// Background jobs: a shell command the model starts and does not wait for (a download, a build, a
// server). Each runs in its own process group, its output goes to a log file and a short tail kept
// in memory, and when it ends the agent is told (main wakes it, or tells it mid-run). Esc does not
// stop a job: the jobs page does (Del twice), and so does quitting kinoko.

import { closeSync, mkdirSync, openSync } from "node:fs";
import type { FileSink } from "bun";
import { join } from "node:path";

export type JobState = "running" | "done" | "failed" | "killed";

export interface Job {
  id: number;
  command: string;
  cwd: string;
  pid: number;
  started: number;
  ended?: number;
  state: JobState;
  code?: number | null;
  /** Where all of its output is. */
  log: string;
}

/** What the tail keeps in memory per job: the window shows it, the end note quotes it. */
const TAIL_CHARS = 64 * 1024;

export class Jobs {
  #dir: string;
  #onEnd: (job: Job) => void;
  #jobs: Array<{ job: Job; tail: string; out: FileSink; ended: Promise<void> }> = [];
  #listeners = new Set<() => void>();
  #next = 1;
  #stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

  constructor(opts: { dir: string; onEnd: (job: Job) => void }) {
    this.#dir = opts.dir;
    this.#onEnd = opts.onEnd;
  }

  /** Starts `command` (sh -c) in `cwd`, on its own: nothing waits for it. */
  start(command: string, cwd: string): Job {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const id = this.#next++;
    const log = join(this.#dir, `${this.#stamp}-${id}.log`);
    // The log is the user's alone (0600); Bun writes it through the descriptor, closed at the end.
    const fd = openSync(log, "w", 0o600);
    const out = Bun.file(fd).writer();
    const ended = Promise.withResolvers<void>();
    const job: Job = { id, command, cwd, pid: -1, started: Date.now(), state: "running", log };
    const entry = { job, tail: "", out, ended: ended.promise };
    this.#jobs.push(entry);
    const take = (chunk: string): void => {
      out.write(chunk);
      out.flush();
      entry.tail = (entry.tail + chunk).slice(-TAIL_CHARS);
      this.#changed();
    };
    const finish = async (code: number | null): Promise<void> => {
      job.ended = Date.now();
      job.code = code;
      if (job.state === "running") job.state = code === 0 ? "done" : "failed";
      await out.end();
      closeSync(fd);
      this.#changed();
      ended.resolve();
      this.#onEnd({ ...job });
    };
    // Its own process group (detached): stopping it stops what it started too.
    let child;
    try {
      child = Bun.spawn(["sh", "-c", command], { detached: true, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      take(`\n[could not start: ${e instanceof Error ? e.message : String(e)}]\n`);
      void finish(null);
      return { ...job };
    }
    job.pid = child.pid;
    const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const text = decoder.decode(bytes, { stream: true });
        if (text !== "") take(text);
      }
    };
    // Ended once it exited and its output is all read (a signal leaves no exit code).
    const proc = child;
    void Promise.all([proc.exited, read(proc.stdout), read(proc.stderr)])
      .catch(() => undefined)
      .then(() => finish(proc.exitCode));
    this.#changed();
    return { ...job };
  }

  list(): Job[] {
    return this.#jobs.map((e) => ({ ...e.job }));
  }

  get running(): number {
    return this.#jobs.filter((e) => e.job.state === "running").length;
  }

  /** Its last `n` lines as a terminal would show them: a progress bar's \r keeps only its last state. */
  tail(id: number, n: number): string[] {
    const entry = this.#jobs.find((e) => e.job.id === id);
    return entry === undefined ? [] : lastLines(entry.tail, n);
  }

  /** Stops a running job (its whole process group); false when it is not running. */
  kill(id: number): boolean {
    const entry = this.#jobs.find((e) => e.job.id === id);
    if (entry === undefined || entry.job.state !== "running") return false;
    entry.job.state = "killed";
    try {
      process.kill(-entry.job.pid, "SIGTERM");
    } catch {
      // gone already
    }
    this.#changed();
    return true;
  }

  /** Quitting kinoko: every job still running ends with it. */
  killAll(): void {
    for (const e of this.#jobs) if (e.job.state === "running") this.kill(e.job.id);
  }

  /** Resolves once the job's process has ended (tests). */
  ended(id: number): Promise<void> {
    return this.#jobs.find((e) => e.job.id === id)?.ended ?? Promise.resolve();
  }

  /** Something changed (a job started, wrote, ended): the UI redraws. */
  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}

/** The last `n` lines of output, carriage returns resolved, colours and trailing blanks out. */
export function lastLines(text: string, n: number): string[] {
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences are exactly what is cut
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const lines = plain.split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1).trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

/** "45s", "3m 12s", "1h 5m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** What the agent is told when a job ends: how, its last lines, where the rest is. */
export function endNote(job: Job, tail: string[]): string {
  const how = job.state === "killed" ? "was stopped" : job.state === "done" ? "finished (exit 0)" : `failed (exit ${job.code ?? "?"})`;
  const took = elapsed((job.ended ?? Date.now()) - job.started);
  const last = tail.length > 0 ? `\nLast lines:\n\`\`\`\n${tail.join("\n")}\n\`\`\`` : "\nIt printed nothing.";
  return `[kinoko] Background job #${job.id} ${how} after ${took}: \`${job.command}\`${last}\nFull output: ${job.log}`;
}
