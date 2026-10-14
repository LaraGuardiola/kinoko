// The messages you sent, kept across runs like a shell's history: ↑ in a new kinoko brings back what
// you sent in the last one. One JSON string per line (a message may hold newlines) in
// ~/.kinoko/history.jsonl, 0600: a prompt can hold anything.

import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";

/** How many a new kinoko starts with (the editor keeps as many). */
export const HISTORY_SIZE = 200;
/** Past this many lines the file is cut back to the newest HISTORY_SIZE, when it is read. */
const FILE_LIMIT = 1000;

const historyFile = (home: string): string => `${home}/.kinoko/history.jsonl`;

/** The newest messages sent, oldest first; none when there is no file yet (or it cannot be read). */
export async function loadPromptHistory(home: string): Promise<string[]> {
  let lines: string[];
  try {
    lines = (await Bun.file(historyFile(home)).text()).split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
  const sent = lines.flatMap((line) => {
    try {
      const text: unknown = JSON.parse(line);
      return typeof text === "string" ? [text] : [];
    } catch {
      return []; // a line cut short (two kinokos writing at once): skipped
    }
  });
  const newest = sent.slice(-HISTORY_SIZE);
  if (lines.length > FILE_LIMIT) await save(home, newest).catch(() => undefined);
  return newest;
}

/** Adds one message at the end of the file. */
export async function addToPromptHistory(home: string, text: string): Promise<void> {
  await mkdir(`${home}/.kinoko`, { recursive: true });
  await appendFile(historyFile(home), `${JSON.stringify(text)}\n`, { mode: 0o600 });
}

async function save(home: string, sent: string[]): Promise<void> {
  const path = historyFile(home);
  await writeFile(path, sent.map((text) => `${JSON.stringify(text)}\n`).join(""), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
