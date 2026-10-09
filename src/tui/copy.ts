// Copying a code block: the code as the model wrote it (no line numbers, padding or soft wraps),
// to the system clipboard. OSC 52 asks the terminal itself (foot, Alacritty, kitty, Ghostty), so it
// works over SSH too; wl-copy or xclip also get it when present, for terminals that refuse OSC 52.

import type { Message } from "../types.ts";
import { fencedBlocks } from "./markdown.ts";

export interface CodeSnippet {
  lang: string;
  code: string;
}

/** Every code block the model wrote in this conversation, oldest first. */
export function snippets(messages: Message[]): CodeSnippet[] {
  return messages.filter((m) => m.role === "assistant").flatMap((m) => fencedBlocks(m.content));
}

/** The escape sequence that puts `text` on the clipboard. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** The desktop's own clipboard tool, best effort and never awaited by the caller's key handling. */
export async function desktopCopy(text: string, env = process.env): Promise<boolean> {
  const cmd = env.WAYLAND_DISPLAY ? ["wl-copy"] : env.DISPLAY ? ["xclip", "-selection", "clipboard"] : undefined;
  if (cmd === undefined) return false;
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(3_000) });
    void proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
