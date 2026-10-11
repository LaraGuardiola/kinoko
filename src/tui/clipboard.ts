// Copying text out of kinoko (/copy). OSC 52 asks the terminal itself to put it on the clipboard:
// it travels over ssh and through a multiplexer that passes it on. wl-copy (Wayland) or xclip (X11),
// when this machine has one, put it there as well, for a terminal that ignores OSC 52.

export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
}

/** Runs a tool with `input` on its stdin: true when it took it. */
export type Feed = (cmd: string[], input: string, signal: AbortSignal) => Promise<boolean>;

const feed: Feed = async (cmd, input, signal) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: new Blob([input]), stdout: "ignore", stderr: "ignore", signal: signal });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};

/** Sends OSC 52 through `write`, then hands `text` to the system clipboard's tool if there is one. */
export async function copyText(text: string, write: (data: string) => void, signal: AbortSignal, run: Feed = feed, env = process.env): Promise<boolean> {
  write(osc52(text));
  const cmd = env.WAYLAND_DISPLAY ? ["wl-copy"] : env.DISPLAY ? ["xclip", "-selection", "clipboard"] : undefined;
  return cmd === undefined ? false : run(cmd, text, signal);
}
