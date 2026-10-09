// The side panel: the model's plan on top, the working tree's changes below, in a column on the
// right of the screen from its top row down to the input's rule, on a background a step lighter
// than the terminal's. The renderer draws it beside the transcript (render.ts); this lays out its
// rows for a given height. Pure.

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

/** The panel's columns: about a quarter of the window, within reason. */
export function panelWidth(cols: number): number {
  return Math.max(36, Math.min(60, Math.round(cols * 0.27)));
}

export interface PanelFacts {
  todos: Todo[];
  /** undefined: not a git repository. */
  changes: FileChange[] | undefined;
  /** The last commit's short hash, shown beside the title. */
  head?: string;
}


/** Padding top and bottom, two headers, the rule between the sections, and the progress bar once there is a plan. */
function fixedRows(facts: PanelFacts): number {
  return facts.todos.length > 0 ? 6 : 5;
}

/** The plan's view: folded (it shares the column) or unfolded by Ctrl+O, scrolled by tasks. */
export interface PlanView {
  expanded: boolean;
  /** The first task shown when unfolded. */
  scroll: number;
}

/**
 * Exactly `height` rows, each `width` columns on the panel background. Folded, when both sections
 * do not fit each gets about half, the plan keeping the task in progress in view and the changes
 * their first files, a "… N more" row saying what was left out. Unfolded (Ctrl+O), the plan takes
 * the column, scrolled by whole tasks, and the changes fold to their title.
 */
export function panelRows(facts: PanelFacts, width: number, height: number, view: PlanView = { expanded: false, scroll: 0 }): string[] {
  const inner = width - 2;
  const items = planItems(facts.todos, inner);
  const bar = facts.todos.length > 0 ? [progressBar(facts.todos, inner)] : [];
  const rule = `${RULE}${"─".repeat(inner)}${ANSI.reset}`;
  let rows: string[];
  if (view.expanded && facts.todos.length > 0) {
    const room = Math.max(1, height - 6);
    rows = ["", planHeader(facts.todos, inner, true), ...bar, ...scrollPlan(items, room, view.scroll), rule, changesHeader(facts.changes, inner, facts.head)];
  } else {
    const changes = changeRows(facts.changes, inner);
    const planLength = items.reduce((n, item) => n + item.length, 0);
    const [planRoom, changeRoom] = splitRoom(planLength, changes.length, Math.max(2, height - fixedRows(facts)));
    rows = [
      "",
      planHeader(facts.todos, inner, false),
      ...bar,
      ...fitPlan(items, facts.todos, planRoom),
      rule,
      changesHeader(facts.changes, inner, facts.head),
      ...fitList(changes, changeRoom, (n) => `${ANSI.dim}… ${n} more file${n === 1 ? "" : "s"}${ANSI.reset}`),
    ];
  }
  while (rows.length < height) rows.push("");
  return rows.slice(0, height).map((row) => paint(row, inner));
}

/** The furthest an unfolded plan scrolls: the first task from which the rest fits (below the "earlier" row). */
export function maxScroll(todos: Todo[], width: number, height: number): number {
  const items = planItems(todos, width - 2);
  const room = Math.max(1, height - 6) - 1;
  let used = 0;
  let start = items.length;
  while (start > 0 && used + items[start - 1]!.length <= room) used += items[--start]!.length;
  return start <= 1 ? 0 : start;
}


// ---- the plan ----

function planHeader(todos: Todo[], inner: number, expanded: boolean): string {
  const done = todos.filter((t) => t.status === "done").length;
  const count = todos.length === 0 ? "" : `${ANSI.dim}${done}/${todos.length}${ANSI.reset}`;
  const keys = expanded ? ` ${ANSI.dim}↑↓ scroll · ctrl+o fold${ANSI.reset}` : "";
  return spread(`${ANSI.bold}${ORANGE}Plan${ANSI.reset}${keys}`, count, inner);
}

/** A thin bar under the plan's title: green for what is done, the rule's colour for the rest. */
function progressBar(todos: Todo[], inner: number): string {
  const done = Math.round((todos.filter((t) => t.status === "done").length / todos.length) * inner);
  return `${ADD}${"━".repeat(done)}${RULE}${"━".repeat(inner - done)}${ANSI.reset}`;
}

/** Each task as its rows (a long one wraps), so the plan is cut and scrolled by whole tasks. */
function planItems(todos: Todo[], inner: number): string[][] {
  if (todos.length === 0) return [[`${ANSI.dim}no plan yet${ANSI.reset}`]];
  return todos.map((todo) => {
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

/** "3 more tasks", "1 earlier task". */
function tasks(n: number, which: "more" | "earlier"): string {
  return `${n} ${which} ${n === 1 ? "task" : "tasks"}`;
}


/** Rows for each section: all they need when both fit; else a section that needs less than half gets it, the other the rest. */
export function splitRoom(plan: number, changes: number, room: number): [number, number] {
  if (plan + changes <= room) return [plan, changes];
  const half = Math.ceil(room / 2);
  if (plan <= half) return [plan, room - plan];
  if (changes <= room - half) return [room - changes, changes];
  return [half, room - half];
}

/**
 * Folded: whole tasks from just before the first unfinished one, as many as fit in `room` rows
 * with one left to say how many tasks are not shown (and that Ctrl+O shows them).
 */
function fitPlan(items: string[][], todos: Todo[], room: number): string[] {
  const all = items.flat();
  if (all.length <= room) return all;
  const first = todos.findIndex((t) => t.status !== "done");
  const start = Math.max(0, (first < 0 ? items.length : first) - 1);
  const shown: string[] = [];
  let taken = 0;
  for (const item of items.slice(start)) {
    if (shown.length + item.length > room - 1) break;
    shown.push(...item);
    taken++;
  }
  if (taken === 0) shown.push(...(items[start] ?? []).slice(0, Math.max(0, room - 1)));
  const hidden = items.length - Math.max(1, taken);
  return [...shown, `${ANSI.dim}… ${tasks(hidden, "more")} · ctrl+o${ANSI.reset}`];
}

/** Unfolded: whole tasks from `scroll` on, with a row above and below saying how many are out of sight. */
function scrollPlan(items: string[][], room: number, scroll: number): string[] {
  const start = Math.max(0, Math.min(scroll, items.length - 1));
  const rows: string[] = start > 0 ? [`${ANSI.dim}↑ ${tasks(start, "earlier")}${ANSI.reset}`] : [];
  let end = start;
  while (end < items.length) {
    const item = items[end]!;
    const last = end === items.length - 1;
    // Room for this task, and for the "more" row unless it is the last one.
    if (rows.length + item.length + (last ? 0 : 1) > room && end > start) break;
    rows.push(...item);
    end++;
  }
  if (end < items.length) rows.push(`${ANSI.dim}↓ ${tasks(items.length - end, "more")}${ANSI.reset}`);
  return rows.slice(0, room);
}

// ---- the changes ----

function changesHeader(changes: FileChange[] | undefined, inner: number, head?: string): string {
  const title = `${ANSI.bold}${ORANGE}Changes${ANSI.reset}${head ? ` ${ANSI.dim}${head}${ANSI.reset}` : ""}`;
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
