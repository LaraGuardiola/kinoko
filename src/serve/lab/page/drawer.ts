// The drawer a machine opens into: what it is for, where its code lives, and what it holds right
// now. The big things (the system prompt, the tools' schemas, the exact request) are asked of the
// agent when wanted, not streamed. Drawn again as the run moves, keeping what was unfolded.

import type { Factory } from "../factory.ts";
import { REPO, SOURCES } from "../machines.ts";
import type { MachineId } from "../machines.ts";
import { MACHINE_WORDS } from "../words.ts";
import { contents } from "./contents.ts";
import { h } from "./dom.ts";

export type Inspectable = "request" | "system" | "tools";
export type Fetched = { data?: unknown; error?: string; loading?: boolean };

export class Drawer {
  #root: HTMLElement;
  #body: HTMLElement;
  #title: HTMLElement;
  #current: MachineId | undefined;
  #fetched = new Map<Inspectable, Fetched>();
  #inspect: (what: Inspectable) => Promise<{ data?: unknown; error?: string }>;
  #factory: Factory | undefined;
  #onClose: () => void;

  constructor(root: HTMLElement, opts: { inspect: (what: Inspectable) => Promise<{ data?: unknown; error?: string }>; close: () => void }) {
    this.#root = root;
    this.#inspect = opts.inspect;
    this.#onClose = opts.close;
    const close = h("button.drawer-close", { type: "button", "aria-label": "Close" }, "✕");
    close.addEventListener("click", () => this.close());
    this.#title = h("h2.drawer-title");
    this.#body = h("div.drawer-body");
    root.replaceChildren(h("div.drawer-head", {}, this.#title, close), this.#body);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.#current) this.close();
    });
  }

  get current(): MachineId | undefined {
    return this.#current;
  }

  open(id: MachineId, factory: Factory): void {
    if (this.#current !== id) this.#body.scrollTop = 0;
    this.#current = id;
    this.#root.classList.add("open");
    document.body.classList.add("drawer-open");
    this.#root.setAttribute("aria-hidden", "false");
    this.render(factory);
  }

  close(): void {
    this.#current = undefined;
    this.#root.classList.remove("open");
    document.body.classList.remove("drawer-open");
    this.#root.setAttribute("aria-hidden", "true");
    this.#onClose();
  }

  /** A new request left: what was fetched about the last one is stale. */
  forget(): void {
    this.#fetched.delete("request");
  }

  /** Another agent: nothing fetched holds. */
  reset(): void {
    this.#fetched.clear();
  }

  render(factory: Factory): void {
    this.#factory = factory;
    const id = this.#current;
    if (id === undefined) return;
    // What was unfolded stays unfolded, and the reader keeps their place.
    const open = new Set([...this.#body.querySelectorAll("details[open]")].map((d) => d.getAttribute("data-key")));
    const scroll = this.#body.scrollTop;
    const words = MACHINE_WORDS[id];
    this.#title.textContent = words.name;
    const sources = h("p.drawer-sources", {}, "Read the code: ");
    SOURCES[id].forEach((path, i) => {
      if (i > 0) sources.append(", ");
      sources.append(h("a", { href: `${REPO}${path}`, target: "_blank", rel: "noopener" }, path));
    });
    const fetcher = (what: Inspectable, label: string): HTMLElement => this.#fetchButton(what, label);
    this.#body.replaceChildren(h("p.drawer-why", {}, words.why), sources, ...contents(id, factory, { fetched: this.#fetched, fetcher }).filter((node) => node !== undefined));
    for (const d of this.#body.querySelectorAll("details")) if (open.has(d.getAttribute("data-key"))) d.setAttribute("open", "");
    this.#body.scrollTop = scroll;
  }

  /** A button that asks the agent for something big, then shows it in place. */
  #fetchButton(what: Inspectable, label: string): HTMLElement {
    const state = this.#fetched.get(what);
    const button = h("button.fetch", { type: "button" }, state?.loading ? "Asking the agent…" : state?.data !== undefined ? "Ask again" : label);
    button.addEventListener("click", () => {
      this.#fetched.set(what, { loading: true });
      if (this.#factory) this.render(this.#factory);
      void this.#inspect(what).then((answer) => {
        this.#fetched.set(what, answer);
        if (this.#factory) this.render(this.#factory);
      });
    });
    return button;
  }
}
