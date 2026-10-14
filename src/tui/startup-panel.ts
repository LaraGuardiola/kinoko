// The panel printed at start (the mushroom, the model, what is switched on). Its [Capabilities]
// lines follow what is switched on later: rewritten in place while they are on screen, or printed
// again once the menu closes when they have scrolled away.

import type { Renderer } from "./render.ts";
import type { Scrollback } from "./scrollback.ts";
import { formatBlock } from "./view.ts";

export interface StartupPanelOptions {
  scrollback: Scrollback;
  renderer: Renderer;
  /** The panel as it is now (extensions and skills switched on or off since). */
  current?: () => Promise<string>;
  render: () => void;
}

export class StartupPanel {
  #opts: StartupPanelOptions;
  #printed: { text: string; gap: boolean } | undefined;
  #stale = false; // changed while scrolled off screen: printed again when the menu closes

  constructor(opts: StartupPanelOptions) {
    this.#opts = opts;
  }

  /** Prints the panel; what follows it is spaced like any other block. */
  print(text: string, gap = false): void {
    const scrollback = this.#opts.scrollback;
    this.#printed = { text, gap };
    this.#stale = false;
    scrollback.print("system", formatBlock("system", text, scrollback.width), gap, "capabilities", (w) => formatBlock("system", text, w));
  }

  /** The [Capabilities] lines as they are now: rewritten in place while on screen, else marked to
   *  be printed again once the menu closes. */
  async refresh(): Promise<void> {
    const { scrollback, renderer } = this.#opts;
    const panel = this.#printed;
    const fresh = await this.#opts.current?.().catch(() => undefined);
    if (panel === undefined || fresh === undefined) return;
    if (scrollback.later(() => void this.refresh())) return;
    const text = withCapabilities(panel.text, fresh);
    if (text === panel.text) return;
    panel.text = text;
    const printed = formatBlock("system", text, scrollback.width);
    const source = (w: number): string => `${panel.gap ? "\n" : ""}${formatBlock("system", text, w)}`;
    if (!renderer.rewrite("capabilities", panel.gap ? `\n${printed}` : printed, source)) this.#stale = true;
    this.#opts.render();
  }

  /** The menu closed: capabilities that changed off screen are printed again, here. */
  menuClosed(): void {
    if (!this.#stale || this.#printed === undefined) return;
    const { lines, at, end } = capabilitiesSection(this.#printed.text);
    if (at < 0) return;
    this.print(lines.slice(at, end).join("\n"), true);
  }
}

/** The panel's head through its [Capabilities] lines: the mushroom (its face is the profile's) and
 *  what is on, all that changes when something is switched. At -1: there are none. */
function capabilitiesSection(text: string): { lines: string[]; at: number; end: number } {
  const lines = text.split("\n");
  const caps = lines.findIndex((line) => line.includes("[Capabilities]"));
  const end = lines.indexOf("", caps + 1);
  return { lines, at: caps < 0 ? -1 : 0, end: end < 0 ? lines.length : end };
}

/** `panel` with its [Capabilities] lines taken from `fresh`. */
export function withCapabilities(panel: string, fresh: string): string {
  const old = capabilitiesSection(panel);
  const now = capabilitiesSection(fresh);
  if (old.at < 0 || now.at < 0) return panel;
  return [...old.lines.slice(0, old.at), ...now.lines.slice(now.at, now.end), ...old.lines.slice(old.end)].join("\n");
}
