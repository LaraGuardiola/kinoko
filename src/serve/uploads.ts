// Files sent from the phone app with a message: saved on this computer in ~/.kinoko/uploads/ and
// named in the prompt, so the agent can read, move or use them. A picture the model can look at
// also goes as an image (as one pasted in the TUI does).

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Image } from "../types.ts";
import { sizeText } from "./bridge-files.ts";

/** One file as the app sends it: its name, its type, its bytes in base64. */
export interface Upload {
  name: string;
  mime?: string;
  data: string;
}

/** A picture larger than this is saved but not sent to the model (as for one pasted in the TUI). */
const IMAGE_MAX = 3_750_000;
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The well-formed uploads of a message (anything else is ignored). */
export function uploadsOf(files: unknown): Upload[] {
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is Upload => typeof f === "object" && f !== null && typeof f.name === "string" && typeof f.data === "string" && f.data !== "");
}

/** A name safe to save under: its own last part, ordinary characters, never empty. */
export function safeName(name: string): string {
  return basename(name).replace(/[^\w.\- ]+/g, "_").trim() || "file";
}

/** Saves them in `dir` (created 700); where each went and its size, and the pictures for the model. */
export async function saveUploads(dir: string, files: Upload[], now = new Date()): Promise<{ saved: Array<{ path: string; size: number }>; images: Image[] }> {
  if (files.length === 0) return { saved: [], images: [] };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const saved: Array<{ path: string; size: number }> = [];
  const images: Image[] = [];
  for (const [i, file] of files.entries()) {
    const bytes = Buffer.from(file.data, "base64");
    const path = join(dir, `${stamp}${files.length > 1 ? `-${i + 1}` : ""}-${safeName(file.name)}`);
    // oxlint-disable-next-line no-await-in-loop -- one file after the other, in the order sent
    await Bun.write(path, bytes);
    saved.push({ path, size: bytes.length });
    if (file.mime && IMAGES.has(file.mime) && bytes.length <= IMAGE_MAX) images.push({ mime: file.mime, data: file.data });
  }
  return { saved, images };
}

/** The message with where its files are, one line each after the text. */
export function withUploads(text: string, saved: Array<{ path: string; size: number }>): string {
  const notes = saved.map((s) => `[sent from the phone: ${s.path} (${sizeText(s.size)})]`).join("\n");
  if (notes === "") return text;
  return text.trim() === "" ? notes : `${text.trim()}\n\n${notes}`;
}
