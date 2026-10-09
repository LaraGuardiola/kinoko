// Pasted images: from the clipboard (Ctrl+V) or from a pasted/dropped file path. Each one gets a
// number, the editor shows it as [Image #N], and on submit the placeholders left in the text decide
// which images go with the message. Everything here is async: a stuck clipboard tool never blocks.

import { homedir } from "node:os";
import type { Image } from "../types.ts";

/** Over this the APIs refuse the image (Anthropic: 5 MB of base64, which is 3.75 MB of bytes). */
export const MAX_IMAGE_BYTES = 3_750_000;

const PLACEHOLDER = /\[Image #(\d+)\]/g;
const EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const CLIPBOARD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The images of a session, by number. Numbers only grow, so #2 always means the same image. */
export class ImageRegistry {
  #images = new Map<number, Image>();
  #next = 1;

  /** Continues the numbering of a resumed session, so new images do not reuse its numbers. */
  startAfter(count: number): void {
    this.#next = Math.max(this.#next, count + 1);
  }

  add(image: Image): string {
    const n = this.#next++;
    this.#images.set(n, image);
    return `[Image #${n}]`;
  }

  /** The images the text still refers to, in order of first mention. */
  attached(text: string): Image[] {
    const seen = new Set<number>();
    const out: Image[] = [];
    for (const match of text.matchAll(PLACEHOLDER)) {
      const n = Number(match[1]);
      const image = this.#images.get(n);
      if (image === undefined || seen.has(n)) continue;
      seen.add(n);
      out.push(image);
    }
    return out;
  }
}

/** The media type from the first bytes, so a mislabelled file or clipboard is still right. */
export function sniffMime(bytes: Uint8Array): string | undefined {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Bytes to an Image, or why not. */
export function toImage(bytes: Uint8Array): Image | string {
  if (bytes.length === 0) return "no image in the clipboard";
  const mime = sniffMime(bytes);
  if (mime === undefined) return "not a PNG, JPEG, GIF or WebP image";
  if (bytes.length > MAX_IMAGE_BYTES) return tooLarge(bytes.length);
  return { mime: mime, data: Buffer.from(bytes).toString("base64") };
}

function tooLarge(size: number): string {
  return `image too large (${(size / 1e6).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1e6} MB)`;
}

/**
 * The path in a paste, when the whole paste is one image file: what a terminal pastes when a file
 * is dropped on it ('quoted', back\ slashed, or file://), or a path typed elsewhere and pasted.
 */
export function imagePathOf(paste: string): string | undefined {
  let text = paste.trim();
  if (text === "" || text.includes("\n")) return undefined;
  if (/^(['"]).*\1$/.test(text)) text = text.slice(1, -1);
  else text = text.replace(/\\(.)/g, "$1");
  if (text.startsWith("file://")) text = decodeURIComponent(text.slice("file://".length));
  if (text.startsWith("~/")) text = `${homedir()}${text.slice(1)}`;
  return EXTENSIONS.test(text) ? text : undefined;
}

/** Reads an image file; undefined when the path is not a file, so the paste stays plain text. */
export async function imageFromFile(path: string, cwd: string): Promise<Image | string | undefined> {
  const file = Bun.file(path.startsWith("/") ? path : `${cwd}/${path}`);
  if (!(await file.exists())) return undefined;
  if (file.size > MAX_IMAGE_BYTES) return tooLarge(file.size);
  return toImage(new Uint8Array(await file.arrayBuffer()));
}

export type Run = (cmd: string[], signal: AbortSignal) => Promise<Uint8Array | undefined>;

/** Runs a clipboard tool; undefined when it is missing, fails or outlives the signal. */
export const runTool: Run = async (cmd, signal) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", signal: signal });
    const [bytes, code] = await Promise.all([new Response(proc.stdout).bytes(), proc.exited]);
    return code === 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The image in the system clipboard: wl-paste on Wayland, xclip on X11. Asks for the list of types
 * first, so a clipboard holding text is told apart from one holding nothing.
 */
export async function clipboardImage(signal: AbortSignal, run: Run = runTool, env = process.env): Promise<Image | string> {
  const tools = env.WAYLAND_DISPLAY
    ? { list: ["wl-paste", "--list-types"], get: (t: string) => ["wl-paste", "--no-newline", "--type", t], name: "wl-paste (wl-clipboard)" }
    : env.DISPLAY
      ? { list: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], get: (t: string) => ["xclip", "-selection", "clipboard", "-t", t, "-o"], name: "xclip" }
      : undefined;
  if (tools === undefined) return "no clipboard here (needs Wayland or X11)";
  const listed = await run(tools.list, signal);
  if (listed === undefined) return `could not read the clipboard: is ${tools.name} installed?`;
  const types = new Set(new TextDecoder().decode(listed).split("\n").map((t) => t.trim()));
  const type = CLIPBOARD_TYPES.find((t) => types.has(t));
  if (type === undefined) return "no image in the clipboard";
  const bytes = await run(tools.get(type), signal);
  return bytes === undefined ? "could not read the clipboard image" : toImage(bytes);
}
