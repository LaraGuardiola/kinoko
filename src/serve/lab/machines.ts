// Kinoko Lab's factory floor: the machines, where each stands, and the belts between them. Two
// blueprints in grid cells, the same belts laid on both: a wide floor for a screen, and a narrow
// one for a phone, two machines across so each stays readable.

export const MACHINE_IDS = [
  "inbox",
  "history",
  "compactor",
  "context",
  "press",
  "toolbox",
  "request",
  "prefill",
  "stream",
  "guards",
  "dispatcher",
  "gate",
  "approval",
  "workbench",
  "jobs",
  "exit",
] as const;

export type MachineId = (typeof MACHINE_IDS)[number];

/** Where to read each machine's code. */
export const SOURCES: Record<MachineId, string[]> = {
  inbox: ["src/loop.ts"],
  history: ["src/session.ts", "src/loop.ts"],
  compactor: ["src/compact.ts"],
  context: ["src/ext.ts"],
  press: ["src/prompt.ts", "src/context.ts"],
  toolbox: ["src/tools/registry.ts", "src/ext.ts"],
  request: ["src/loop.ts", "src/providers"],
  prefill: ["src/providers/openai-compat.ts"],
  stream: ["src/loop.ts", "src/providers"],
  guards: ["src/guard.ts"],
  dispatcher: ["src/loop.ts"],
  gate: ["src/ext.ts", "src/loop.ts"],
  approval: ["src/approvals.ts"],
  workbench: ["src/tools"],
  jobs: ["src/jobs.ts"],
  exit: ["src/loop.ts"],
};

export const REPO = "https://github.com/LaraGuardiola/kinoko/blob/main/";

/** A point in grid cells: [column, row]. A machine stands centred on its cell. */
export type Cell = [number, number];

export interface Belt {
  from: MachineId;
  to: MachineId;
  /** The corners between the two machines' centres, in cells. */
  via?: Cell[];
}

export interface Blueprint {
  cols: number;
  rows: number;
  at: Record<MachineId, Cell>;
  belts: Belt[];
}

// The run goes left to right along the middle (history → request → the model), comes back right
// to left below it (calls → gate → tools), and what joins the history rides the lane between the two.
const LANE = 1.5;

export const FLOOR: Blueprint = {
  cols: 6,
  rows: 4,
  at: {
    inbox: [0, 0],
    press: [2, 0],
    toolbox: [3, 0],
    history: [0, 1],
    context: [1, 1],
    request: [2, 1],
    prefill: [3, 1],
    stream: [4, 1],
    guards: [5, 1],
    compactor: [0, 2],
    jobs: [2, 2],
    workbench: [3, 2],
    gate: [4, 2],
    dispatcher: [5, 2],
    approval: [4, 3],
    exit: [5, 3],
  },
  belts: [
    { from: "inbox", to: "history" },
    { from: "history", to: "context" },
    { from: "context", to: "request" },
    { from: "press", to: "request", via: [[1.88, 0], [1.88, 1]] },
    { from: "toolbox", to: "request", via: [[3, 0.5], [2.12, 0.5], [2.12, 1]] },
    { from: "request", to: "prefill" },
    { from: "prefill", to: "stream" },
    { from: "stream", to: "guards" },
    { from: "guards", to: "dispatcher" },
    { from: "dispatcher", to: "gate" },
    { from: "gate", to: "workbench" },
    { from: "gate", to: "approval", via: [[3.9, 2], [3.9, 3]] },
    { from: "approval", to: "gate", via: [[4.1, 3], [4.1, 2]] },
    { from: "approval", to: "workbench", via: [[3.5, 3], [3.5, 2]] },
    { from: "workbench", to: "jobs" },
    { from: "dispatcher", to: "exit" },
    { from: "history", to: "compactor", via: [[-0.12, 1], [-0.12, 2]] },
    { from: "compactor", to: "history", via: [[0.12, 2], [0.12, 1]] },
    // What joins the history: the reply, the results, a refused call's answer, the guards' nudges.
    { from: "stream", to: "history", via: [[4, LANE], [0.3, LANE], [0.3, 1]] },
    { from: "workbench", to: "history", via: [[3, LANE], [0.3, LANE], [0.3, 1]] },
    { from: "gate", to: "history", via: [[4, LANE], [0.3, LANE], [0.3, 1]] },
    { from: "guards", to: "history", via: [[5.3, 1], [5.3, LANE], [0.3, LANE], [0.3, 1]] },
  ],
};

// Narrow: the way out runs down the left column, the tools come after, and what joins the history
// climbs the left edge. Two lanes may cross: like Factorio's underground belts, they do not meet.
const EDGE = -0.5;

export const PHONE_FLOOR: Blueprint = {
  cols: 2,
  rows: 9,
  at: {
    inbox: [0, 0],
    history: [0, 1],
    compactor: [1, 1],
    context: [0, 2],
    press: [1, 2],
    request: [0, 3],
    toolbox: [1, 3],
    prefill: [0, 4],
    stream: [0, 5],
    guards: [1, 5],
    gate: [0, 6],
    dispatcher: [1, 6],
    workbench: [0, 7],
    approval: [1, 7],
    jobs: [0, 8],
    exit: [1, 8],
  },
  belts: [
    { from: "inbox", to: "history" },
    { from: "history", to: "context" },
    { from: "context", to: "request" },
    { from: "press", to: "request", via: [[0.5, 2], [0.5, 3]] },
    { from: "toolbox", to: "request" },
    { from: "request", to: "prefill" },
    { from: "prefill", to: "stream" },
    { from: "stream", to: "guards" },
    { from: "guards", to: "dispatcher" },
    { from: "dispatcher", to: "gate" },
    { from: "gate", to: "workbench" },
    { from: "gate", to: "approval", via: [[0.3, 6], [0.3, 6.45], [1, 6.45]] },
    { from: "approval", to: "gate", via: [[0.7, 7], [0.7, 6.55], [0.15, 6.55], [0.15, 6]] },
    { from: "approval", to: "workbench" },
    { from: "workbench", to: "jobs" },
    { from: "dispatcher", to: "exit", via: [[1.5, 6], [1.5, 8]] },
    { from: "history", to: "compactor", via: [[0, 0.92], [1, 0.92]] },
    { from: "compactor", to: "history", via: [[1, 1.08], [0, 1.08]] },
    { from: "stream", to: "history", via: [[EDGE, 5], [EDGE, 1]] },
    { from: "workbench", to: "history", via: [[EDGE, 7], [EDGE, 1]] },
    { from: "gate", to: "history", via: [[EDGE, 6], [EDGE, 1]] },
    { from: "guards", to: "history", via: [[1, 4.5], [EDGE, 4.5], [EDGE, 1]] },
  ],
};

/** A belt's points, in cells: from one machine's centre, round its corners, to the other's. */
export function beltPoints(plan: Blueprint, belt: Belt): Cell[] {
  return [plan.at[belt.from], ...(belt.via ?? []), plan.at[belt.to]];
}

/** The points an item rides along a route of machines, belt after belt (a straight line where none is laid). */
export function routePoints(plan: Blueprint, route: MachineId[]): Cell[] {
  const points: Cell[] = [];
  for (let i = 0; i + 1 < route.length; i++) {
    const from = route[i] as MachineId;
    const to = route[i + 1] as MachineId;
    const belt = plan.belts.find((b) => b.from === from && b.to === to);
    const leg = belt ? beltPoints(plan, belt) : [plan.at[from], plan.at[to]];
    points.push(...(points.length > 0 ? leg.slice(1) : leg));
  }
  return points;
}
