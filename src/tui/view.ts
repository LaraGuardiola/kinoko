// How the live region looks: pure functions, no state. The App decides what is true, this decides
// how the rows look.
//
// Model of the screen: everything that is FINISHED lives in the terminal's own scrollback, in the
// order it happened (user, thinking, answer, tool, thinking, answer...). The live region only
// holds what is still moving: the one block being streamed, the running tool, queued messages,
// the editor and the status line.

import { fenceOpener, isClosing, renderMarkdown } from "./markdown.ts";
import { ANSI, clipAnsi, visibleLength, wrapAnsi, wrapWords } from "./style.ts";
import { pulseDot, toolHead } from "./tools.ts";
import { modelName } from "../prompt.ts";

export { wrapAnsi } from "./style.ts";

/** Rows of streaming text kept in the live region before the stable part moves to scrollback. */
export const STREAM_ROWS = 12;
export const ABORTED = "Aborted by user"; // what the Agent puts back for a cut-short tool

export type BlockKind = "user" | "thinking" | "assistant" | "tool" | "system";

export interface ToolView {
  name: string;
  args: string;
  output: string;
  aborted: boolean;
}

export interface QueuedView {
  kind: "steer" | "followUp";
  text: string;
}

export interface Tokens {
  /** How full the context is: the last request's prompt plus what it generated. */
  context: number;
  /** Totals over the session, for the cache hit rate. */
  input: number;
  cacheRead: number;
  /** Everything the model generated this session, thinking included (it is not resent, so it
   *  costs time, not context). */
  output: number;
}

/** The block that is being streamed right now. At most one exists at any time. */
export interface OpenBlock {
  kind: "thinking" | "assistant";
  text: string;
  /** A blank row goes before it (it follows another block). */
  gap: boolean;
}

export interface RegionInput {
  open: OpenBlock | undefined;
  tool: ToolView | undefined;
  /** A blank row goes before the running tool line. */
  toolGap?: boolean;
  /** How lit the bullet of the tool in progress is (0..1): it fades in and out until the result. */
  pulse?: number;
  marker: string;
  /** The marker reports an interruption: red, like the input rules. */
  markerAlert?: boolean;
  /** A quiet note (compaction): cream, no background. */
  markerCream?: boolean;
  queued: QueuedView[];
  /** An approval waiting for the user: its rows, in the marker's place. */
  approval?: string[];
  editorLines: string[];
  editorRow: number;
  editorCol: number;
  status: string;
  /** Where we are: "~/Projects/kinoko (master)", shown under the editor. */
  place?: string;
  /** The thinking level ("LOW · 2048"), set into the right end of the rule above the editor. */
  thinking?: string;
  /** Background jobs running ("⚙ 2 shells"), left of the thinking level: a click opens them. */
  jobs?: string;
  /** The slash menu's rows, between the rule under the editor and the place line. */
  menu?: string[];
  /** Columns for the rows above the input's rule (the streamed text), when a side column takes the rest. */
  tailCols?: number;
  viewportRows?: number;
  viewportCols?: number;
}

export interface Region {
  lines: string[];
  row: number;
  col: number;
  /** Rows above the input's rule (a side column runs down beside them). */
  upper: number;
}

/** A finished block as terminal rows. Used both for scrollback and for the open block. */
export function formatBlock(kind: BlockKind, text: string, width?: number): string {
  // The region asks for the open block on every frame; markdown with code panes is not free, so
  // the last answer is kept while the text has not changed.
  const key = `${kind}\u0000${width ?? ""}\u0000${text}`;
  if (key !== lastFormat.key) lastFormat = { key, value: formatUncached(kind, text, width) };
  return lastFormat.value;
}

let lastFormat = { key: "", value: "" };

function formatUncached(kind: BlockKind, text: string, width?: number): string {
  // A tab advances to a tab stop the width math cannot see: spaces keep the rows honest.
  const body = text.replace(/^\n+|\n+$/g, "").replace(/\t/g, "    ");
  if (body === "") return "";
  switch (kind) {
    case "user":
      return body
        .split("\n")
        .map((line) => `${ANSI.user}${line}${ANSI.reset}`)
        .join("\n");
    case "thinking":
      return thinkingBlock(body);
    case "assistant":
      return renderMarkdown(body, { width: width });
    default:
      // Broken between words, each line's indent kept on its next rows: the terminal alone would
      // cut mid-word ("a codi" / "ng task").
      return width === undefined ? body : body.split("\n").flatMap((line) => wrapWords(line, width, /^ */.exec(line)?.[0] ?? "")).join("\n");
  }
}

/**
 * Streaming text that has grown past STREAM_ROWS: splits it into a part that is stable (moves to
 * the scrollback, once, in order) and the rest (stays live). Cuts at the last paragraph boundary;
 * a paragraph taller than the region is cut by line. Never inside a code fence or a table: those
 * stay live until they end, so they are always rendered whole (column widths, line numbers,
 * highlighting). Returns undefined while everything still fits or there is no safe cut.
 */
export function splitStable(
  text: string,
  cols: number | undefined,
  limit = STREAM_ROWS,
): { commit: string; rest: string; gap: boolean } | undefined {
  const width = Math.max(1, (cols ?? 80) - 2);
  const lines = text.split("\n");
  const rowsOf = (line: string): number => Math.max(1, Math.ceil(line.length / width));
  const total = lines.reduce((sum, line) => sum + rowsOf(line), 0);
  if (total <= limit || lines.length < 2) return undefined;

  // inFence[i]: line i is inside a fence (its body or its closing line).
  const inFence: boolean[] = [];
  let marker: string | undefined;
  for (const line of lines) {
    inFence.push(marker !== undefined);
    if (marker !== undefined) {
      if (isClosing(line, marker)) marker = undefined;
    } else marker = fenceOpener(line);
  }
  // Two neighbouring rows with pipes are (or are becoming) one table.
  const cutOk = (cut: number): boolean => !inFence[cut] && !((lines[cut - 1] ?? "").includes("|") && (lines[cut] ?? "").includes("|"));
  const restRows = (from: number): number => lines.slice(from).reduce((sum, line) => sum + rowsOf(line), 0);

  // Preferred: everything before the paragraph that is being written now.
  for (let cut = lines.length - 1; cut >= 1; cut--) {
    if (lines[cut - 1]?.trim() !== "" || !cutOk(cut)) continue;
    if (restRows(cut) > limit) break; // the live paragraph alone is too tall: cut by line instead
    return { commit: lines.slice(0, cut).join("\n").replace(/\n+$/, ""), rest: lines.slice(cut).join("\n"), gap: true };
  }

  // Fallback: keep roughly half the region as the live tail, moved up past any open block.
  const keep = Math.ceil(limit / 2);
  let cut = lines.length - 1;
  let rows = rowsOf(lines[cut] ?? "");
  while (cut > 1 && rows + rowsOf(lines[cut - 1] ?? "") <= keep) {
    cut--;
    rows += rowsOf(lines[cut] ?? "");
  }
  while (cut >= 1 && !cutOk(cut)) cut--;
  if (cut < 1) return undefined;
  const paragraph = lines[cut - 1]?.trim() === "";
  const commit = lines.slice(0, cut).join("\n");
  return { commit: paragraph ? commit.replace(/\n+$/, "") : commit, rest: lines.slice(cut).join("\n"), gap: paragraph };
}

/** The live region: the open block, the running tool, marker, queued messages, editor, status. */
export function liveRegion(input: RegionInput): Region {
  let tail: string[] = [];
  const open = input.open;
  if (open !== undefined) {
    const cols = input.tailCols ?? input.viewportCols;
    const text = formatBlock(open.kind, open.text, cols === undefined ? undefined : cols - 2);
    if (text !== "") {
      if (open.gap) tail.push("");
      tail.push(...text.split("\n"));
    }
  }
  if (input.tool !== undefined) {
    if (input.toolGap) tail.push("");
    tail.push(`${toolHead(input.tool, input.pulse === undefined ? undefined : pulseDot(input.pulse))} ${ANSI.dim}…${ANSI.reset}`);
  }
  if (input.marker !== "") {
    // A blank row keeps the note off whatever was streamed before it.
    const style = input.markerAlert ? ANSI.amanita : input.markerCream ? ANSI.cream : ANSI.inverse;
    tail.push("", `${style}${input.marker}${ANSI.reset}`);
  }
  if (input.approval !== undefined) tail.push(...input.approval);
  if (input.queued.length > 0) {
    // A row of air, the keys that act on the queue, then the messages waiting, in cream.
    const steering = input.queued.some((item) => item.kind === "steer");
    tail.push("", `${ANSI.dim}${steering ? "alt+x send now · " : ""}alt+c cancel · alt+↑ edit the last${ANSI.reset}`);
    for (const item of input.queued) {
      const tag = item.kind === "steer" ? "[steer]" : "[follow-up]";
      tail.push(`${ANSI.cream}${tag} ${item.text}${ANSI.reset}`);
    }
  }
  // The editor sits between two rules, with a block cursor drawn in place (the terminal's own
  // cursor stays hidden).
  const editor = input.editorLines.map((line, i) => (i === input.editorRow ? withCursor(line, input.editorCol) : line));
  const ruleWidth = Math.max(1, (input.viewportCols ?? 80) - 2);
  const rule = `${ANSI.amanita}${"─".repeat(ruleWidth)}${ANSI.reset}`;
  // A blank row keeps the transcript off the input.
  let head = ["", labelledRule(ruleWidth, input.thinking, input.jobs)];
  let foot = [rule, ...(input.menu ?? []), ...(input.place ? [placeRow(input.place)] : []), input.status];

  const viewport = input.viewportRows;
  const tailCols = input.tailCols ?? input.viewportCols;
  const width = tailCols === undefined ? undefined : Math.max(1, tailCols - 2);
  if (width !== undefined) tail = tail.flatMap((line) => wrapAnsi(line, width));
  if (viewport === undefined || viewport < 2) {
    const rows = [...tail, ...head, ...editor, ...foot];
    return region(rows, tail.length + head.length + input.editorRow, input.editorCol, input.viewportCols, tail.length + Math.min(1, head.length));
  }

  // The region must stay shorter than the terminal, or its top scrolls out of reach and cannot be
  // repainted. When the tail does not fit, only its last rows are shown: the rest of a streamed
  // block was already moved to the scrollback by splitStable, so this only trims extremes. A tiny
  // viewport drops the chrome first: the editor row and the status always stay.
  if (viewport < head.length + foot.length + 1) {
    head = [];
    foot = [input.status];
  }
  const editorRoom = Math.max(1, viewport - head.length - foot.length);
  const editorStartAt = Math.max(0, Math.min(input.editorRow - editorRoom + 1, editor.length - editorRoom));
  const visibleEditor = editor.length <= editorRoom ? editor : editor.slice(editorStartAt, editorStartAt + editorRoom);
  const contentRoom = Math.max(0, viewport - visibleEditor.length - head.length - foot.length);
  const visibleTail = contentRoom === 0 ? [] : tail.slice(-contentRoom);
  const rows = [...visibleTail, ...head, ...visibleEditor, ...foot];
  const row = visibleTail.length + head.length + input.editorRow - editorStartAt;
  // The rows above the rule: the streamed text and the blank row before the rule.
  return region(rows, row, input.editorCol, input.viewportCols, visibleTail.length + Math.min(1, head.length));
}

/** The path in amanita's cream stem, the branch in its red cap. */
/** The rule above the editor, with `label` near its right end: "──────── LOW · 2048 ──". */
function labelledRule(width: number, label: string | undefined, jobs?: string): string {
  const own = label ? `${ANSI.bold}${ANSI.cream}${label}${ANSI.reset}` : "";
  // The background jobs, left of the thinking level: orange, like the menu's names.
  const job = jobs ? `${JOBS_COLOR}${jobs}${ANSI.reset}` : "";
  const labels = [job, own].filter((l) => l !== "");
  const used = labels.reduce((n, l) => n + visibleLength(l) + 2, 0) + (labels.length > 1 ? 2 : 0) + 2;
  const left = width - used;
  if (labels.length === 0 || left < 4) return `${ANSI.amanita}${"─".repeat(width)}${ANSI.reset}`;
  const between = `${ANSI.amanita}──${ANSI.reset}`;
  return `${ANSI.amanita}${"─".repeat(left)}${ANSI.reset} ${labels.join(` ${between} `)} ${between}`;
}

/** The background jobs' label on the rule above the input. */
const JOBS_COLOR = "\x1b[38;5;214m";

function placeRow(place: string): string {
  const branch = /^(.*) \(([^)]*)\)$/.exec(place);
  if (branch === null) return `${ANSI.cream}${place}${ANSI.reset}`;
  return `${ANSI.cream}${branch[1]}${ANSI.reset} ${ANSI.amanita}(${branch[2]})${ANSI.reset}`;
}

/** Draws the block cursor over the character at `col` (a space past the end of the line). */
function withCursor(line: string, col: number): string {
  const code = line.codePointAt(col);
  const under = code === undefined ? " " : String.fromCodePoint(code);
  return `${line.slice(0, col)}${ANSI.inverse}${under}${ANSI.reset}${line.slice(col + (code === undefined ? 1 : under.length))}`;
}

/** Model reasoning is display-only: muted and distinct from the answer. */
export function thinkingBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `${ANSI.dim}${ANSI.italic}${line}${ANSI.reset}`)
    .join("\n");
}

/** Keeps a live row inside the terminal margin: terminals wrap a margin write on the next byte. */
function region(rows: string[], row: number, col: number, width: number | undefined, upper: number): Region {
  if (width === undefined) return { lines: rows, row, col, upper };
  const max = Math.max(1, width - 2);
  return { lines: rows.map((line) => clipAnsi(line, max)), row, col: Math.min(col, max), upper };
}

export function statusLine(parts: {
  running: boolean;
  model: string;
  tokens: Tokens;
  contextWindow: number;
  cost: number;
}): string {
  const used = parts.tokens.context;
  const cache = parts.tokens.input > 0 ? Math.round((parts.tokens.cacheRead / parts.tokens.input) * 100) : 0;
  const full = parts.contextWindow > 0 ? ` ${Math.round((used / parts.contextWindow) * 100)}%` : "";
  return [
    parts.running ? "RUNNING" : "IDLE",
    modelName(parts.model),
    `${used.toLocaleString("en-US")}/${parts.contextWindow.toLocaleString("en-US")} tok${full}`,
    // Up: sent to the model (every request's whole prompt). Down: what it generated.
    `↑ ${parts.tokens.input.toLocaleString("en-US")} ↓ ${parts.tokens.output.toLocaleString("en-US")}`,
    `cache ${cache}%`,
    parts.cost > 0 ? `$${parts.cost.toFixed(4)}` : "",
  ]
    .filter((part) => part !== "")
    .join(`${ANSI.dim} | ${ANSI.reset}`);
}

/** Hard wraps a logical editor line to the terminal width. */
export function wrapTo(width: number): (line: string) => string[] {
  return (line: string) => (line.length <= width ? [line] : (line.match(new RegExp(`.{1,${width}}`, "g")) ?? [line]));
}
