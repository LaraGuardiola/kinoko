// The factory floor, drawn: a hand-written SVG of the machines (tiles), the belts between them, and
// the items riding the belts. Wide screens get the wide floor, phones the narrow one. It draws what
// it is told (tiles, moves) and says which machine was picked.

import type { ItemKind, Move } from "../factory.ts";
import { FLOOR, MACHINE_IDS, PHONE_FLOOR, beltPoints, routePoints } from "../machines.ts";
import type { Blueprint, Cell, MachineId } from "../machines.ts";
import type { Tile } from "../tiles.ts";
import { MACHINE_WORDS } from "../words.ts";
import { ICONS } from "./icons.ts";

const SVG = "http://www.w3.org/2000/svg";

interface Geometry {
  plan: Blueprint;
  cell: { w: number; h: number };
  tile: { w: number; h: number };
  pad: number;
  tall: boolean;
  font: { name: number; tag: number; now: number };
  /** Where each line of a tile sits, from its top: the name, the tag, what it is doing. */
  line: { name: number; tag: number; now: number };
  icon: number;
}

const WIDE: Geometry = { plan: FLOOR, cell: { w: 200, h: 140 }, tile: { w: 168, h: 100 }, pad: 28, tall: false, font: { name: 15, tag: 11.5, now: 12.5 }, line: { name: 28, tag: 47, now: 72 }, icon: 1.9 };
const TALL: Geometry = { plan: PHONE_FLOOR, cell: { w: 180, h: 104 }, tile: { w: 150, h: 84 }, pad: 20, tall: true, font: { name: 15, tag: 11, now: 12.5 }, line: { name: 24, tag: 41, now: 63 }, icon: 1.7 };

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** A text cut to what fits `width` at `size` (an average glyph is ~0.58 em wide). */
function fit(text: string, width: number, size: number): string {
  const max = Math.floor(width / (size * 0.58));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

interface Riding {
  node: SVGGElement;
  points: Array<[number, number]>;
  lengths: number[];
  total: number;
  start: number;
  duration: number;
  to: MachineId;
  belts: SVGPathElement[];
}

export class Board {
  #root: HTMLElement;
  #svg: SVGSVGElement | undefined;
  #geo: Geometry = WIDE;
  #tiles = new Map<MachineId, { group: SVGGElement; now: SVGTextElement; bar: SVGRectElement }>();
  #belts = new Map<string, SVGPathElement>();
  #items: SVGGElement | undefined;
  #riding: Riding[] = [];
  #frame = 0;
  #last: Partial<Record<MachineId, Tile>> = {};
  #pick: (id: MachineId) => void;
  /** Cells per second an item travels at 1×. */
  speed = 3.2;

  constructor(root: HTMLElement, pick: (id: MachineId) => void) {
    this.#root = root;
    this.#pick = pick;
    this.#layout();
    new ResizeObserver(() => this.#layout()).observe(root);
  }

  /** Wide or tall, by the room there is; drawn again only when that changes. */
  #layout(): void {
    const tall = this.#root.clientWidth < 640;
    if (this.#svg !== undefined && tall === this.#geo.tall) return;
    this.#geo = tall ? TALL : WIDE;
    this.#draw();
    for (const [id, tile] of Object.entries(this.#last)) if (tile) this.#paint(id as MachineId, tile);
  }

  #px([c, r]: Cell): [number, number] {
    const { cell, pad } = this.#geo;
    return [pad + (c + 0.5) * cell.w, pad + (r + 0.5) * cell.h];
  }

  #draw(): void {
    const { plan, cell, tile, pad, font, line, icon, tall } = this.#geo;
    const width = plan.cols * cell.w + pad * 2;
    const height = plan.rows * cell.h + pad * 2;
    this.#riding = [];
    this.#tiles.clear();
    this.#belts.clear();
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: `floor ${tall ? "tall" : "wide"}`, role: "img", "aria-label": "The harness as a factory: machines and belts" });
    const defs = el("defs", {}, svg);
    const grid = el("pattern", { id: "floor-grid", width: 20, height: 20, patternUnits: "userSpaceOnUse" }, defs);
    el("rect", { x: 0, y: 0, width: 20, height: 20, class: "floor-cell" }, grid);
    el("rect", { x: 0, y: 0, width, height, fill: "url(#floor-grid)", rx: 14 }, svg);

    const belts = el("g", { class: "belts" }, svg);
    for (const belt of plan.belts) {
      const d = beltPoints(plan, belt)
        .map((p, i) => `${i === 0 ? "M" : "L"}${this.#px(p).join(" ")}`)
        .join(" ");
      el("path", { d, class: "belt-bed" }, belts);
      this.#belts.set(`${belt.from}>${belt.to}`, el("path", { d, class: "belt" }, belts));
    }

    // Items ride under the machines: they vanish into one and come out of the next, as in Factorio.
    this.#items = el("g", { class: "items" }, svg);
    const tiles = el("g", { class: "tiles" }, svg);
    for (const id of MACHINE_IDS) {
      const [cx, cy] = this.#px(plan.at[id]);
      const x = cx - tile.w / 2;
      const y = cy - tile.h / 2;
      const group = el("g", { class: "tile tone-idle", tabindex: 0, role: "button", "aria-label": MACHINE_WORDS[id].name, "data-id": id }, tiles);
      el("rect", { x, y, width: tile.w, height: tile.h, rx: 12, class: "tile-body" }, group);
      this.#icon(id, x + tile.w - 12, y + 12, icon, group);
      el("text", { x: x + 12, y: y + line.name, class: "tile-name", "font-size": font.name }, group).textContent = MACHINE_WORDS[id].name;
      el("text", { x: x + 12, y: y + line.tag, class: "tile-tag", "font-size": font.tag }, group).textContent = fit(MACHINE_WORDS[id].tag, tile.w - 20, font.tag);
      const now = el("text", { x: x + 12, y: y + line.now, class: "tile-now", "font-size": font.now }, group);
      el("rect", { x: x + 10, y: y + tile.h - 12, width: tile.w - 20, height: 4, rx: 2, class: "tile-track" }, group);
      const bar = el("rect", { x: x + 10, y: y + tile.h - 12, width: 0, height: 4, rx: 2, class: "tile-bar" }, group);
      group.addEventListener("click", () => this.#pick(id));
      group.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this.#pick(id);
      });
      this.#tiles.set(id, { group, now, bar });
    }
    this.#root.replaceChildren(svg);
    this.#svg = svg;
  }

  /** A machine's pixel sign, its top right corner at (right, top), each pixel `px` wide. */
  #icon(id: MachineId, right: number, top: number, px: number, parent: Element): void {
    const rows = ICONS[id];
    const width = (rows[0]?.length ?? 8) * px;
    const g = el("g", { class: "tile-icon", "shape-rendering": "crispEdges" }, parent);
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] === "#") el("rect", { x: right - width + c * px, y: top + r * px, width: px, height: px }, g);
    });
  }

  /** Shows each machine's state. */
  update(tiles: Record<MachineId, Tile>, selected?: MachineId): void {
    for (const id of MACHINE_IDS) {
      this.#last[id] = tiles[id];
      this.#paint(id, tiles[id]);
      this.#tiles.get(id)?.group.classList.toggle("selected", id === selected);
    }
  }

  #paint(id: MachineId, tile: Tile): void {
    const drawn = this.#tiles.get(id);
    if (drawn === undefined) return;
    const { tile: size, font } = this.#geo;
    const kept = ["selected", "pulse"].filter((c) => drawn.group.classList.contains(c));
    drawn.group.setAttribute("class", ["tile", `tone-${tile.tone}`, ...(tile.progress === undefined ? [] : ["measured"]), ...kept].join(" "));
    drawn.now.textContent = fit(tile.now, size.w - 22, font.now);
    drawn.bar.setAttribute("width", String(tile.progress === undefined ? 0 : Math.max(0, Math.min(1, tile.progress)) * (size.w - 20)));
  }

  /** Sends items along their routes; `speed` 1 is live, less is slower. */
  send(moves: Move[], speed: number): void {
    for (const move of moves) {
      const launch = (): void => this.#launch(move, speed);
      if (move.delay) setTimeout(launch, move.delay / speed);
      else launch();
    }
  }

  #launch(move: Move, speed: number): void {
    const items = this.#items;
    if (items === undefined || this.#riding.length > 60) return; // a burst too big to follow: skip it
    const cells = routePoints(this.#geo.plan, move.route);
    const points = cells.map((p) => this.#px(p));
    const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
    const total = lengths.reduce((a, b) => a + b, 0);
    const cellLength = cells.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - cells[i]![0], p[1] - cells[i]![1]), 0);
    const duration = Math.max(350, (cellLength / this.speed) * 1000) / speed;
    const node = el("g", { class: `item item-${move.kind satisfies ItemKind}` }, items);
    el("circle", { r: 6.5 }, node);
    if (move.label && move.kind === "call") el("text", { y: -11, "text-anchor": "middle", class: "item-label" }, node).textContent = move.label;
    const belts = move.route.slice(1).flatMap((to, i) => this.#belts.get(`${move.route[i]}>${to}`) ?? []);
    for (const belt of belts) belt.classList.add("running");
    this.#riding.push({ node, points, lengths, total, start: performance.now(), duration, to: move.route.at(-1) as MachineId, belts });
    if (this.#frame === 0) this.#frame = requestAnimationFrame((t) => this.#tick(t));
  }

  #tick(now: number): void {
    const arrived: Riding[] = [];
    this.#riding = this.#riding.filter((r) => {
      const t = Math.min(1, (now - r.start) / r.duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      let along = eased * r.total;
      let at = r.points[0]!;
      for (let i = 0; i < r.lengths.length; i++) {
        const leg = r.lengths[i]!;
        const a = r.points[i]!;
        const b = r.points[i + 1]!;
        if (along <= leg || i === r.lengths.length - 1) {
          const k = leg === 0 ? 1 : Math.min(1, along / leg);
          at = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
          break;
        }
        along -= leg;
      }
      r.node.setAttribute("transform", `translate(${at[0]} ${at[1]})`);
      if (t < 1) return true;
      r.node.remove();
      arrived.push(r);
      return false;
    });
    for (const r of arrived) this.#arrive(r);
    this.#frame = this.#riding.length > 0 ? requestAnimationFrame((t) => this.#tick(t)) : 0;
  }

  /** An item reached its machine: the tile takes it with a pulse; its belts rest unless busy. */
  #arrive(r: Riding): void {
    const group = this.#tiles.get(r.to)?.group;
    group?.classList.remove("pulse");
    void group?.getBoundingClientRect(); // restart the pulse when two items arrive close together
    group?.classList.add("pulse");
    setTimeout(() => group?.classList.remove("pulse"), 450);
    for (const belt of r.belts) if (!this.#riding.some((o) => o.belts.includes(belt))) belt.classList.remove("running");
  }
}
