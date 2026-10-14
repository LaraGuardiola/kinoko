// The model in use, where it is served and how big its context window is; the /models page that
// switches it, adds providers and picks the default; and the check at start that the model
// configured is one its endpoint serves.

import { DEFAULTS } from "../config.ts";
import type { SavedModel } from "../config.ts";
import type { Agent } from "../loop.ts";
import { modelName } from "../prompt.ts";
import type { Served } from "../providers/openai-compat.ts";
import type { Session } from "../session.ts";
import type { Provider } from "../types.ts";
import type { Marker } from "./marker.ts";
import type { ListPage, Menu } from "./menu.ts";
import { mismatchNote } from "./model-check.ts";
import { endpointOf, endpointPage, hostOf, keyPage, labelPage, modelsPage, namePage, servedPage } from "./models-menu.ts";
import type { ModelChoice, ModelsView } from "./models-menu.ts";

/** What the models page needs from outside the TUI: other endpoints, and somewhere to save them. */
export interface ModelsHost {
  /** The endpoint in use at start. */
  endpoint: string;
  /** Models to offer besides the engine's own: the configured one, and those added before. */
  saved: SavedModel[];
  connect: (entry: SavedModel) => Provider;
  discover: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<Served[]>;
  /** Saves one entry; answers with the list to offer from now on. */
  save: (entry: SavedModel) => Promise<SavedModel[]>;
  /** Removes one saved entry; answers with the list to offer from now on. */
  remove: (entry: SavedModel) => Promise<SavedModel[]>;
  /** Entries that cannot be removed from the TUI (the configured model, the default). */
  fixed: (entry: SavedModel) => boolean;
  /** Makes one the model new sessions start with; answers with the list to offer from now on. */
  setDefault?: (entry: SavedModel) => Promise<SavedModel[]>;
}

export interface ModelSwitchOptions {
  agent: () => Agent;
  host: ModelsHost | undefined;
  model: string;
  contextWindow: number;
  /** Started with no model set up anywhere. */
  noModel: boolean;
  menu: Menu;
  marker: Marker;
  /** The session in use, which remembers a switch so a resume starts with it. */
  session: () => Session | undefined;
  closeMenu: () => void;
  render: () => void;
}

export class ModelSwitch {
  #opts: ModelSwitchOptions;
  #model: string;
  #window: number;
  #endpoint: string;
  #saved: SavedModel[];
  #noModel: boolean;

  constructor(opts: ModelSwitchOptions) {
    this.#opts = opts;
    this.#model = opts.model;
    this.#window = opts.contextWindow;
    this.#endpoint = opts.host?.endpoint ?? "";
    this.#saved = opts.host?.saved ?? [];
    this.#noModel = opts.noModel;
  }

  get model(): string {
    return this.#model;
  }

  get contextWindow(): number {
    return this.#window;
  }

  /** None set up yet: the status says so, and a prompt opens this page instead. */
  get noModel(): boolean {
    return this.#noModel;
  }

  /** At start: the note to print when the model in use is not one its endpoint serves. */
  async mismatch(): Promise<string | undefined> {
    if (this.#noModel) return undefined;
    const model = this.#model;
    const served = await this.#agent.models(AbortSignal.timeout(5_000)).catch(() => [] as string[]);
    if (this.#model !== model) return undefined; // a pick came first
    return mismatchNote(model, served, this.#endpoint === "" ? "the engine" : hostOf(this.#endpoint));
  }

  /** The models to pick from (the phone's /models): the saved ones, then what the engine serves. */
  async list(signal: AbortSignal): Promise<Array<{ name: string; description: string }>> {
    const items = new Map(this.#saved.map((e) => [e.model, { name: e.model, description: e.label ?? hostOf(e.baseUrl) }]));
    for (const m of await this.#agent.models(signal).catch(() => [] as string[])) if (!items.has(m)) items.set(m, { name: m, description: `served by ${hostOf(this.#endpoint)}` });
    return [...items.values()];
  }

  /** Switches to a model by name (the phone's /models): a saved one, or one the engine in use serves. */
  useByName(name: string): string {
    const current = this.#saved.find((e) => e.baseUrl === this.#endpoint);
    this.use(this.#saved.find((e) => e.model === name) ?? { model: name, baseUrl: this.#endpoint, apiKey: current?.apiKey ?? "" });
    return this.#opts.marker.text;
  }

  /** The /models page: every provider is asked what it serves, in parallel, and the page fills in
   *  as they answer. */
  open(): void {
    const host = this.#opts.host;
    const served = new Map<string, Served[]>();
    const others = [...new Map(this.#saved.filter((m) => m.baseUrl !== this.#endpoint).map((m) => [m.baseUrl, m])).values()];
    let pending = 1 + (host ? others.length : 0);
    const view = (): ModelsView => ({
      model: this.#model,
      endpoint: this.#endpoint,
      served,
      loading: pending > 0,
      saved: this.#saved,
      canAdd: host !== undefined,
      fixed: host?.fixed,
      canDefault: host?.setDefault !== undefined,
    });
    const choose = (choice: ModelChoice): void => {
      if (choice.kind === "add") this.#addProvider();
      // The redrawn page becomes the one later answers refresh.
      else if (choice.kind === "remove") this.#remove(choice.entry, () => (page = modelsPage(view(), choose)));
      else if (choice.kind === "default") this.#makeDefault(choice.entry, () => (page = modelsPage(view(), choose)));
      else this.use(choice.entry);
    };
    let page = modelsPage(view(), choose);
    this.#opts.menu.open(page);
    const answered = (baseUrl: string, list: Served[]): void => {
      pending--;
      if (list.length > 0) served.set(baseUrl, list);
      const next = modelsPage(view(), choose);
      this.#opts.menu.refresh(page, next);
      page = next;
      this.#opts.render();
    };
    void this.#agent
      .models(AbortSignal.timeout(10_000))
      .catch(() => [])
      .then((names) => answered(this.#endpoint, names.map((id) => ({ id }))));
    for (const entry of host ? others : []) {
      void host
        ?.discover(entry.baseUrl, entry.apiKey, AbortSignal.timeout(10_000))
        .catch(() => [])
        .then((list) => answered(entry.baseUrl, list));
    }
  }

  /** Switches to a model, and to its endpoint when it is served elsewhere; then its window. */
  use(entry: SavedModel): void {
    const host = this.#opts.host;
    this.#noModel = false;
    if (entry.baseUrl !== this.#endpoint && host) {
      this.#agent.setProvider(host.connect(entry));
      this.#endpoint = entry.baseUrl;
    }
    this.#agent.setModel(entry.model);
    this.#model = entry.model;
    this.#opts.marker.inform(`model: ${modelName(entry.model)}${entry.baseUrl === "" ? "" : ` at ${hostOf(entry.baseUrl)}`} from the next request`);
    if (entry.contextWindow) this.#useWindow(entry.contextWindow);
    else this.#learnWindow(entry);
    this.#record(entry, entry.contextWindow);
  }

  get #agent(): Agent {
    return this.#opts.agent();
  }

  /** Forgets a saved model; the page stays open, redrawn without it. */
  #remove(entry: SavedModel, redraw: () => ListPage): void {
    const { menu, marker } = this.#opts;
    const page = menu.page;
    void this.#opts.host
      ?.remove(entry)
      .then((saved) => {
        this.#saved = saved;
        if (page) menu.refresh(page, redraw());
        marker.inform(`removed ${modelName(entry.model)} at ${hostOf(entry.baseUrl)}`);
      })
      .catch(() => marker.warn(`could not remove ${modelName(entry.model)}`))
      .finally(() => this.#opts.render());
  }

  /** Makes a model the default for new sessions (config.json); the page stays open, redrawn. */
  #makeDefault(entry: SavedModel, redraw: () => ListPage): void {
    const { menu, marker } = this.#opts;
    const page = menu.page;
    void this.#opts.host
      ?.setDefault?.(entry)
      .then((saved) => {
        this.#saved = saved;
        if (page) menu.swap(page, redraw()); // the same model stays selected
        marker.inform(`default: ${modelName(entry.model)} at ${hostOf(entry.baseUrl)}, for new sessions`);
      })
      .catch(() => marker.warn(`could not make ${modelName(entry.model)} the default`))
      .finally(() => this.#opts.render());
  }

  /** Its name, endpoint, API key, then one of the models it serves (or its id typed by hand). */
  #addProvider(): void {
    const menu = this.#opts.menu;
    menu.open(
      labelPage((typedLabel) => {
        const label = typedLabel.trim();
        if (label === "") return; // nothing typed: stay on this step
        menu.open(
          endpointPage((typed) => {
            const baseUrl = endpointOf(typed);
            if (baseUrl === undefined) return;
            menu.open(keyPage((apiKey) => this.#discover(label, baseUrl, apiKey.trim())));
          }),
        );
      }),
    );
  }

  #discover(label: string, baseUrl: string, apiKey: string): void {
    const { menu, marker } = this.#opts;
    const host = hostOf(baseUrl);
    const keep = (served: Served): void => {
      const entry: SavedModel = { model: served.id, baseUrl, apiKey, contextWindow: served.contextWindow, label };
      this.#opts.closeMenu();
      this.use(entry);
      void this.#opts.host
        ?.save(entry)
        .then((saved) => {
          this.#saved = saved;
          marker.inform(`model: ${modelName(entry.model)} at ${host}, saved`);
        })
        .catch(() => marker.warn(`model: ${modelName(entry.model)} at ${host} (could not save it)`))
        .finally(() => this.#opts.render());
    };
    const asking = servedPage(host, undefined, keep);
    menu.open(asking);
    // An endpoint that answers but lists nothing, and one that does not answer at all, both lead
    // to typing the id; only the second is probably a mistake (a wrong port, a server not started).
    const byHand = (reachable: boolean): void => {
      menu.refresh(asking, namePage(host, reachable, (id) => id.trim() && keep({ id: id.trim() })));
    };
    void this.#opts.host
      ?.discover(baseUrl, apiKey, AbortSignal.timeout(10_000))
      .then((served) => (served.length > 0 ? menu.refresh(asking, servedPage(host, served, keep)) : byHand(true)))
      .catch(() => byHand(false))
      .finally(() => this.#opts.render());
  }

  /** The session remembers the switch (and the window, once known), so a resume starts with it. */
  #record(entry: SavedModel, contextWindow: number | undefined): void {
    const record = { model: entry.model, baseUrl: entry.baseUrl, ...(contextWindow ? { contextWindow } : {}) };
    void this.#opts.session()?.setModel(record).catch(() => undefined);
  }

  #useWindow(window: number): void {
    this.#agent.setContextWindow(window);
    this.#window = window;
  }

  /**
   * A model picked without a known window (typed by hand, or served by the engine in use): ask its
   * endpoint, use what it says, and keep it on a saved entry so the next pick knows it at once.
   * Until then the previous window stands; if it never says (or does not answer), the default one,
   * as a fresh start has, and the marker says so.
   */
  #learnWindow(entry: SavedModel): void {
    const host = this.#opts.host;
    if (!host || entry.baseUrl === "") return;
    void host
      .discover(entry.baseUrl, entry.apiKey, AbortSignal.timeout(10_000))
      .catch(() => [] as Served[])
      .then(async (served) => {
        const window = served.find((s) => s.id === entry.model)?.contextWindow;
        if (this.#model !== entry.model) return; // another pick came first
        if (!window) {
          // The last model's window says nothing about this one: the default, as a fresh start has.
          this.#useWindow(DEFAULTS.contextWindow);
          this.#opts.marker.inform(`model: ${modelName(entry.model)} (its context window is unknown: ${DEFAULTS.contextWindow.toLocaleString("en-US")}, the default)`);
          return;
        }
        this.#useWindow(window);
        this.#record(entry, window);
        const saved = this.#saved.some((m) => m.baseUrl === entry.baseUrl && m.model === entry.model && !host.fixed(m));
        if (saved) this.#saved = await host.save({ ...entry, contextWindow: window });
      })
      .catch(() => undefined)
      .finally(() => this.#opts.render());
  }
}
