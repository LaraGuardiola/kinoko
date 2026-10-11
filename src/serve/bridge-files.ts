// Files sent to the bot: downloaded into ~/.kinoko/telegram/ and handed to the agent as a prompt
// that names the path. A photo also goes as an image on the prompt, so a vision model sees it.

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Image } from "../types.ts";
import type { Telegram, TgFile, TgMessage } from "./telegram.ts";

/** Telegram lets a bot download files up to this size. */
export const DOWNLOAD_MAX = 20 * 1024 * 1024;

export interface Received {
  path: string;
  size: number;
  /** A photo: its bytes as an image for the prompt. */
  image?: Image;
}

/** The file a message carries, with the name to save it under; undefined when it has none. */
export function fileOf(m: TgMessage, now = new Date()): { file: TgFile; name: string; photo: boolean } | undefined {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const photo = m.photo?.at(-1); // the largest size
  if (photo) return { file: photo, name: `${stamp}-photo.jpg`, photo: true };
  const file = m.document ?? m.video ?? m.audio ?? m.voice;
  if (!file) return undefined;
  const given = file.file_name ? basename(file.file_name).replace(/[^\w.\- ]+/g, "_").trim() : "";
  const fallback = m.voice ? "voice.ogg" : m.video ? "video.mp4" : m.audio ? "audio" : "file";
  return { file, name: `${stamp}-${given || fallback}`, photo: false };
}

/** Downloads the message's file into `dir`; throws a sentence for the user when it cannot. */
export async function receive(api: Telegram, m: TgMessage, dir: string, signal: AbortSignal): Promise<Received> {
  const found = fileOf(m);
  if (!found) throw new Error("no file in that message");
  if ((found.file.file_size ?? 0) > DOWNLOAD_MAX) throw new Error(`${sizeText(found.file.file_size ?? 0)} is more than a bot may download from Telegram (20 MB)`);
  const bytes = await api.download(await api.getFile(found.file.file_id, signal), signal);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, found.name);
  await Bun.write(path, bytes);
  return { path, size: bytes.length, ...(found.photo ? { image: { mime: "image/jpeg", data: Buffer.from(bytes).toString("base64") } } : {}) };
}

/** The prompt for a received file: the caption, then where the file is. */
export function filePrompt(caption: string | undefined, r: Received): string {
  const note = `[sent from Telegram: ${r.path} (${sizeText(r.size)})]`;
  return caption?.trim() ? `${caption.trim()}\n\n${note}` : note;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
