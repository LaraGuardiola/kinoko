// The side panel: the model's plan and the working tree's changes, side by side in a band above the
// input, on a background a step lighter than the terminal's. It shows only when the window has room
// for it (two thirds of the screen or more), and goes as soon as it does not. The input, the rules
// and the status line stay where they always are: the band only pushes the transcript up.
// Pure: the App gathers the facts, this lays them out.

import { ORANGE } from "./menu.ts";
import { ANSI, clipAnsi, visibleLength, wrapWords } from "./style.ts";
import type { FileChange } from "./changes.ts";
import type { Todo } from "./todos.ts";

/** A step above the terminal's own background, below a code panel's. */
export const PANEL_BG = "\x1b[48;2;32;34;48m";
const ADD = "\x1b[38;2;158;206;106m"; // additions and finished items: a soft green
const DEL = "\x1b[38;2;240;113;120m"; // removals: a soft red, kin to the amanita rules
const RULE = "\x1b[38;2;65;72;104m"; // the line between the two sections

/** The window's share of the screen from which the panel shows. */
export const WIDE_SHARE = 2 / 3;
/** When the terminal does not say how big the screen is: columns from which the panel shows. */
export const WIDE_COLS = 140;
/** Under this the left column would be too cramped, whatever the share. */
const MIN_COLS = 100;

/** True when the panel has room: the window's share of the screen if known, else its columns. */
export function wideEnough(cols: number, share: number | undefined): boolean {
  if (cols < MIN_COLS) return false;
  return share === undefined ? cols >= WIDE_COLS : share >= WIDE_SHARE - 0.005;
}

export interface PanelFacts {
  todos: Todo[];
  /** undefined: not a git repository. */
  changes: FileChange[] | undefined;
}

/** Between the two columns: a thin rule with a column of air each side. */
const DIVIDER = ` ${RULE}│${ANSI.reset} `;

/** The two columns' widths inside `inner`: the plan gets a little more, its lines are longer. */
export function columns(inner: number): [number, number] {
  const plan = Math.round((inner - 3) * 0.55);
  return [plan, inner - 3 - plan];
}

/**
 * The band: `width` columns, at most `maxRows` rows (padding included), the plan on the left and
 * the changes on the right, each column cut to the room with a "… N more" row (the plan keeping
 * its first unfinished item in view).
 */
export function panelBand(facts: PanelFacts, width: number, maxRows: number): string[] {
  const inner = width - 2;
  const [planWidth, changesWidth] = columns(inner);
  const plan = planRows(facts.todos, planWidth);
  const changes = changeRows(facts.changes, changesWidth);
  const bar = facts.todos.length > 0 ? 1 : 0;
  // Each column: its header (and the plan's bar), then its rows; padding above and below the band.
  const want = Math.max(1 + bar + plan.length, 1 + changes.length);
  const room = Math.max(1, Math.min(want, maxRows - 2));
  const left = [
    planHeader(facts.todos, planWidth),
    ...(bar ? [progressBar(facts.todos, planWidth)] : []),
    ...fitPlan(plan, facts.todos, Math.max(1, room - 1 - bar), planWidth),
  ];
  const right = [
    changesHeader(facts.changes, changesWidth),
    ...fitList(changes, Math.max(1, room - 1), (n) => `${ANSI.dim}… ${n} more file${n === 1 ? "" : "s"}${ANSI.reset}`),
  ];
  const body = Array.from({ length: room }, (_, i) => `${cell(left[i] ?? "", planWidth)}${DIVIDER}${cell(right[i] ?? "", changesWidth)}`);
  return ["", ...body, ""].map((row) => paint(row, inner));
}

/** One column's row, clipped and padded to its width, so the divider stays straight. */
function cell(content: string, width: number): string {
  const fitted = clipAnsi(content, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

// ---- the plan ----

function planHeader(todos: Todo[], inner: number): string {
  const done = todos.filter((t) => t.status === "done").length;
  const count = todos.length === 0 ? "" : `${ANSI.dim}${done}/${todos.length}${ANSI.reset}`;
  return spread(`${ANSI.bold}${ORANGE}Plan${ANSI.reset}`, count, inner);
}

/** A thin bar under the plan's title: green for what is done, the rule's colour for the rest. */
function progressBar(todos: Todo[], inner: number): string {
  const done = Math.round((todos.filter((t) => t.status === "done").length / todos.length) * inner);
  return `${ADD}${"━".repeat(done)}${RULE}${"━".repeat(inner - done)}${ANSI.reset}`;
}

function planRows(todos: Todo[], inner: number): string[] {
  if (todos.length === 0) return [`${ANSI.dim}no plan yet${ANSI.reset}`];
  return todos.flatMap((todo) => {
    const [mark, style] =
      todo.status === "done"
        ? [`${ADD}✓${ANSI.reset}`, ANSI.dim]
        : todo.status === "in_progress"
          ? [`${ANSI.toolDot}●${ANSI.reset}`, `${ANSI.bold}${ANSI.cream}`]
          : [`${ANSI.dim}○${ANSI.reset}`, ""];
    const lines = wrapWords(todo.text, Math.max(1, inner - 2));
    return lines.map((line, i) => `${i === 0 ? mark : " "} ${style}${line}${ANSI.reset}`);
  });
}

/** The plan cut to `room` rows around the first unfinished item, so the work at hand stays seen. */
function fitPlan(rows: string[], todos: Todo[], room: number, inner: number): string[] {
  if (rows.length <= room) return rows;
  const first = todos.findIndex((t) => t.status !== "done");
  // Rows before the first unfinished item (a wrapped item takes several).
  const before = todos.slice(0, Math.max(0, first)).reduce((n, t) => n + wrapWords(t.text, Math.max(1, inner - 2)).length, 0);
  const start = Math.max(0, Math.min(before - 1, rows.length - (room - 1)));
  const shown = rows.slice(start, start + room - 1);
  const hidden = rows.length - shown.length;
  return [...shown, `${ANSI.dim}… ${hidden} more row${hidden === 1 ? "" : "s"}${ANSI.reset}`];
}

// ---- the changes ----

function changesHeader(changes: FileChange[] | undefined, inner: number): string {
  const title = `${ANSI.bold}${ORANGE}Changes${ANSI.reset}`;
  if (changes === undefined || changes.length === 0) return title;
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const files = `${ANSI.dim}${changes.length} file${changes.length === 1 ? "" : "s"}${ANSI.reset}`;
  return spread(title, `${files} ${counts(added, removed)}`, inner);
}

function changeRows(changes: FileChange[] | undefined, inner: number): string[] {
  if (changes === undefined) return [`${ANSI.dim}not a git repository${ANSI.reset}`];
  if (changes.length === 0) return [`${ANSI.dim}no changes${ANSI.reset}`];
  return changes.map((c) => {
    const stats = c.binary ? `${ANSI.dim}${c.fresh ? "new " : ""}bin${ANSI.reset}` : `${c.fresh ? `${ANSI.dim}new${ANSI.reset} ` : ""}${counts(c.added, c.removed)}`;
    const room = Math.max(4, inner - visibleLength(stats) - 1);
    return spread(dimDirs(shortPath(c.path, room)), stats, inner);
  });
}

function counts(added: number, removed: number): string {
  const parts = [added > 0 || removed === 0 ? `${ADD}+${added}${ANSI.reset}` : "", removed > 0 ? `${DEL}−${removed}${ANSI.reset}` : ""];
  return parts.filter((p) => p !== "").join(" ");
}

/** The directories dimmed, the file name as is: the eye goes to the name. */
function dimDirs(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : `${ANSI.dim}${path.slice(0, slash + 1)}${ANSI.reset}${path.slice(slash + 1)}`;
}

/** A path that fits: the file name stays, the directories give way from the left ("…/tui/app.ts"). */
export function shortPath(path: string, max: number): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const tail = `…/${parts.slice(i).join("/")}`;
    if (tail.length <= max) return tail;
  }
  const name = parts.at(-1) ?? path;
  return name.length <= max ? name : `…${name.slice(name.length - max + 1)}`;
}

// ---- layout helpers ----

/** The first `room` rows; when some are left out, the last row says how many. */
function fitList(rows: string[], room: number, more: (n: number) => string): string[] {
  if (rows.length <= room) return rows;
  const shown = rows.slice(0, Math.max(0, room - 1));
  return [...shown, more(rows.length - shown.length)];
}

/** `left` and `right` on one row of `inner` columns, `right` against the right edge. */
function spread(left: string, right: string, inner: number): string {
  const gap = inner - visibleLength(left) - visibleLength(right);
  return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : left;
}

/** One panel row: the background edge to edge, a column of padding each side. */
function paint(content: string, inner: number): string {
  const fitted = clipAnsi(content, inner);
  const body = fitted.replaceAll(ANSI.reset, `${ANSI.reset}${PANEL_BG}`);
  const pad = " ".repeat(Math.max(0, inner - visibleLength(fitted)));
  return `${PANEL_BG} ${body}${pad} ${ANSI.reset}`;
}
