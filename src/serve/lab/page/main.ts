// Kinoko Lab in the browser: signs in to the hub, follows one agent, and turns each of its events
// into the floor's new state (factory), items on the belts (board) and the open drawer's contents.

import { Factory } from "../factory.ts";
import { MACHINE_IDS } from "../machines.ts";
import type { MachineId } from "../machines.ts";
import { tileOf } from "../tiles.ts";
import type { Tile } from "../tiles.ts";
import { SAY, short } from "../words.ts";
import type { AgentEvent } from "../../../agent-events.ts";
import type { Message } from "../../../types.ts";
import { Board } from "./board.ts";
import { h } from "./dom.ts";
import { Drawer } from "./drawer.ts";
import type { Inspectable } from "./drawer.ts";
import { Hub, signIn } from "./hub.ts";
import type { HubMessage } from "./hub.ts";
import { drawMascot } from "./mascot.ts";

/** What the hub says about each agent (docs/protocol.md AgentInfo), as far as the Lab needs. */
interface AgentCard {
  id: string;
  project: string;
  model: string;
  origin: "app" | "terminal";
  state: "starting" | "idle" | "running" | "exited";
  title?: string;
}

const SPEEDS = [1, 0.5, 0.25];
const SPEED_KEY = "kinoko-lab-speed";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function savedSpeed(): number {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

class Lab {
  #hub: Hub;
  #factory = new Factory();
  #agents: AgentCard[] = [];
  #current: string | undefined;
  #speed = savedSpeed();
  #board: Board;
  #drawer: Drawer;
  #frame = 0;
  #drawerAt = 0;
  #connectedOnce = false;
  /** Where the run is and since when: a phase that takes a while says how long (prefill, an approval). */
  #phase: { at: MachineId | undefined; since: number } = { at: undefined, since: 0 };

  constructor(token: string) {
    this.#board = new Board($("board"), (id) => this.#pick(id));
    this.#drawer = new Drawer($("drawer"), { inspect: (what) => this.#inspect(what), close: () => this.#render() });
    this.#hub = new Hub(token, { message: (msg) => this.#message(msg), state: (up) => this.#connection(up) });
    $("agent").addEventListener("change", (e) => void this.#attach((e.target as HTMLSelectElement).value));
    this.#speedButtons();
    this.#render();
    setInterval(() => {
      if (this.#factory.running) this.#render();
    }, 1000);
  }

  #connection(up: boolean): void {
    $("link").className = up ? "link up" : "link down";
    $("link").title = up ? "Connected to kinoko serve" : "Reconnecting…";
    // Back after a drop: the agent's story again, from the hub (nothing is lost).
    if (up && this.#connectedOnce && this.#current) void this.#attach(this.#current);
    if (up) this.#connectedOnce = true;
  }

  #message(msg: HubMessage): void {
    if (msg.type === "hello") {
      drawMascot($("mascot"), typeof msg.profile === "string" ? msg.profile : undefined);
      this.#list(msg.agents as AgentCard[]);
    } else if (msg.type === "agents") this.#list(msg.agents as AgentCard[]);
    else if (msg.type === "profile") drawMascot($("mascot"), typeof msg.profile === "string" ? msg.profile : undefined);
    else if (msg.type === "event" && msg.agent === this.#current) this.#event(msg.event as AgentEvent);
  }

  /** The agents in the picker; the one followed stays, else the most recently active one. */
  #list(agents: AgentCard[]): void {
    this.#agents = agents.filter((a) => a.state !== "exited");
    const select = $("agent") as HTMLSelectElement;
    select.replaceChildren(...this.#agents.map((a) => h("option", { value: a.id }, `${a.origin === "terminal" ? "⌨" : "📱"} ${a.project} · ${a.state}${a.title ? ` · ${a.title.slice(0, 40)}` : ""}`)));
    if (this.#agents.length === 0) {
      this.#current = undefined;
      this.#render();
      return;
    }
    if (this.#current === undefined || !this.#agents.some((a) => a.id === this.#current)) void this.#attach(this.#agents[0]!.id);
    else select.value = this.#current;
  }

  async #attach(id: string): Promise<void> {
    if (this.#current && this.#current !== id) this.#hub.tell({ type: "detach", agent: this.#current });
    this.#current = id;
    ($("agent") as HTMLSelectElement).value = id;
    const answer = await this.#hub.ask({ type: "attach", agent: id });
    if (answer.type !== "history" || this.#current !== id) return;
    const factory = new Factory();
    factory.load(answer.messages as Message[]);
    factory.model = (answer.info as AgentCard | undefined)?.model ?? "";
    // The run in progress, as it happened so far: the floor catches up without animating.
    for (const event of answer.live as AgentEvent[]) factory.apply(event);
    this.#factory = factory;
    this.#drawer.reset();
    this.#render();
  }

  #event(event: AgentEvent): void {
    const moves = this.#factory.apply(event);
    this.#board.send(moves, this.#speed);
    if (event.type === "request_start") this.#drawer.forget();
    this.#render();
  }

  #pick(id: MachineId): void {
    if (this.#drawer.current === id) this.#drawer.close();
    else this.#drawer.open(id, this.#factory);
    this.#render();
  }

  async #inspect(what: Inspectable): Promise<{ data?: unknown; error?: string }> {
    if (this.#current === undefined) return { error: "No agent." };
    const answer = await this.#hub.ask({ type: "inspect", agent: this.#current, what });
    return answer.type === "inspected" ? { data: answer.data } : { error: String(answer.detail ?? "The agent did not answer.") };
  }

  /** Draws the floor at the next frame: a burst of events costs one drawing. */
  #render(): void {
    if (this.#frame !== 0) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const f = this.#factory;
      const tiles = Object.fromEntries(MACHINE_IDS.map((id) => [id, tileOf(f, id)])) as Record<MachineId, Tile>;
      const waited = this.#waited(f);
      const here = f.cursor === undefined ? undefined : tiles[f.cursor];
      if (waited && here) here.now = `${here.now} · ${waited}`;
      this.#board.update(tiles, this.#drawer.current);
      $("caption").textContent = this.#current === undefined ? SAY.noAgent : `${f.caption}${waited ? ` (${waited})` : ""}`;
      $("caption").classList.toggle("running", f.running);
      this.#stats(f);
      // The drawer is heavier (a whole history): a few times a second is enough to read it live.
      const now = performance.now();
      if (this.#drawer.current && now - this.#drawerAt > 250) {
        this.#drawerAt = now;
        this.#drawer.render(f);
      } else if (this.#drawer.current) setTimeout(() => this.#render(), 260);
    });
  }

  /** How long the run has been where it is, once that is long enough to wonder ("12s"). */
  #waited(f: Factory): string | undefined {
    const now = performance.now();
    if (f.cursor !== this.#phase.at) this.#phase = { at: f.cursor, since: now };
    const seconds = Math.floor((now - this.#phase.since) / 1000);
    return f.running && seconds >= 3 ? (seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`) : undefined;
  }

  #stats(f: Factory): void {
    const t = f.totals;
    const cache = t.input > 0 ? Math.round((t.cached / t.input) * 100) : 0;
    const parts = [f.model ? f.model.split("/").at(-1) : "", f.running ? `request #${f.turn}` : "", t.input > 0 ? `${short(t.input)} tokens read · ${short(t.output)} written · ${cache}% from cache` : "", f.jobs ? `${f.jobs} in the background` : ""];
    $("stats").textContent = parts.filter(Boolean).join("  ·  ");
  }

  #speedButtons(): void {
    const group = $("speed");
    const buttons = SPEEDS.map((s) => {
      const button = h("button", { type: "button", "aria-pressed": String(s === this.#speed), title: s === 1 ? "Live" : "Slowed down, to follow it" }, s === 1 ? "1×" : s === 0.5 ? "½×" : "¼×");
      button.addEventListener("click", () => {
        this.#speed = s;
        for (const [i, b] of buttons.entries()) b.setAttribute("aria-pressed", String(SPEEDS[i] === s));
        try {
          localStorage.setItem(SPEED_KEY, String(s));
        } catch {
          // not kept: fine
        }
      });
      return button;
    });
    group.replaceChildren(...buttons);
  }
}

async function start(): Promise<void> {
  drawMascot($("mascot"), undefined);
  const token = await signIn().catch(() => undefined);
  if (token === undefined) {
    $("signin").hidden = false;
    return;
  }
  const lab = new Lab(token);
  Object.assign(window, { kinokoLab: lab }); // there to poke at from the console
}

void start();
