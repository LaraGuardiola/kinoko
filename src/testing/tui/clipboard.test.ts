import { describe, expect, test } from "bun:test";
import { copyText, osc52 } from "../../tui/clipboard.ts";

/** A copy with a fake tool runner: what was written to the terminal, and the tool runs. */
async function copy(env: Record<string, string>): Promise<{ took: boolean; written: string[]; calls: string[][] }> {
  const written: string[] = [];
  const calls: string[][] = [];
  const run = async (cmd: string[], input: string): Promise<boolean> => (calls.push([...cmd, input]), true);
  const took = await copyText("x", (d) => written.push(d), AbortSignal.timeout(1000), run, env);
  return { took, written, calls };
}

describe("clipboard", () => {
  test("OSC 52 carries the text in base64, UTF-8 intact", () => {
    expect(osc52("añade ⧉")).toBe(`\x1b]52;c;${Buffer.from("añade ⧉").toString("base64")}\x07`);
  });

  test("OSC 52 always goes out; wl-copy on Wayland, xclip on X11, nothing without either", async () => {
    const [wayland, x11, none] = await Promise.all([copy({ WAYLAND_DISPLAY: "wayland-1" }), copy({ DISPLAY: ":0" }), copy({})]);
    expect(wayland).toEqual({ took: true, written: [osc52("x")], calls: [["wl-copy", "x"]] });
    expect(x11).toEqual({ took: true, written: [osc52("x")], calls: [["xclip", "-selection", "clipboard", "x"]] });
    expect(none).toEqual({ took: false, written: [osc52("x")], calls: [] });
  });
});
