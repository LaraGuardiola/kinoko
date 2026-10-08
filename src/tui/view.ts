// How the live region looks: pure functions, no state. The App decides what is true, this decides
// how the rows look.
//
// Model of the screen: everything that is FINISHED lives in the terminal's own scrollback, in the
// order it happened (user, thinking, answer, tool, thinking, answer...). The live region only
// holds what is still moving: the one block being streamed, the running tool, queued messages,
// the editor and the status line.

import { fenceOpener, isClosing, renderMarkdown } from "./markdown.ts";
import { ANSI, clipAnsi, wrapAnsi } from "./style.ts";
import { toolHead } from "./tools.ts";

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
  marker: string;
  /** The marker reports an interruption: red, like the input rules. */
  markerAlert?: boolean;
  queued: QueuedView[];
  editorLines: string[];
  editorRow: number;
  editorCol: number;
  status: string;
  /** Where we are: "~/Projects/kinoko (master)", shown under the editor. */
  place?: string;
  viewportRows?: number;
  viewportCols?: number;
}

export interface Region {
  lines: string[];
  row: number;
  col: number;
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
      return body;
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
    const text = formatBlock(open.kind, open.text, input.viewportCols === undefined ? undefined : input.viewportCols - 2);
    if (text !== "") {
      if (open.gap) tail.push("");
      tail.push(...text.split("\n"));
    }
  }
  if (input.tool !== undefined) {
    if (input.toolGap) tail.push("");
    tail.push(`${toolHead(input.tool)} ${ANSI.dim}…${ANSI.reset}`);
  }
  if (input.marker !== "") {
    // A blank row keeps the note off whatever was streamed before it.
    tail.push("", input.markerAlert ? `${ANSI.amanita}${input.marker}${ANSI.reset}` : `${ANSI.inverse}${input.marker}${ANSI.reset}`);
  }
  for (const item of input.queued) {
    const tag = item.kind === "steer" ? "[steer]" : "[follow-up]";
    tail.push(`${ANSI.dim}${tag}${ANSI.reset} ${item.text}`);
  }
  // The editor sits between two rules, with a block cursor drawn in place (the terminal's own
  // cursor stays hidden).
  const editor = input.editorLines.map((line, i) => (i === input.editorRow ? withCursor(line, input.editorCol) : line));
  const rule = `${ANSI.amanita}${"─".repeat(Math.max(1, (input.viewportCols ?? 80) - 2))}${ANSI.reset}`;
  // A blank row keeps the transcript off the input.
  let head = ["", rule];
  let foot = [rule, ...(input.place ? [placeRow(input.place)] : []), input.status];

  const viewport = input.viewportRows;
  const width = input.viewportCols === undefined ? undefined : Math.max(1, input.viewportCols - 2);
  if (width !== undefined) tail = tail.flatMap((line) => wrapAnsi(line, width));
  if (viewport === undefined || viewport < 2) {
    const rows = [...tail, ...head, ...editor, ...foot];
    return region(rows, tail.length + head.length + input.editorRow, input.editorCol, input.viewportCols);
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
  return region(rows, row, input.editorCol, input.viewportCols);
}

/** The path in amanita's cream stem, the branch in its red cap. */
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
function region(rows: string[], row: number, col: number, width: number | undefined): { lines: string[]; row: number; col: number } {
  if (width === undefined) return { lines: rows, row, col };
  const max = Math.max(1, width - 2);
  return { lines: rows.map((line) => clipAnsi(line, max)), row, col: Math.min(col, max) };
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
  return [
    parts.running ? `${ANSI.inverse}RUNNING${ANSI.reset}` : "IDLE",
    parts.model,
    `${used.toLocaleString("en-US")}/${parts.contextWindow.toLocaleString("en-US")} tok`,
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


export const HELP = [
  "kinoko keys",
  "",
  "  Enter          send as prompt (idle) / steer (running)",
  "  Alt+Enter      follow-up (running) / send as prompt (idle), kitty-protocol terminals",
  "  Esc            abort the run (nothing when idle)",
  "  Ctrl-C         abort / clear the editor / quit on a second press",
  "  Ctrl-D         quit when the editor is empty",
  "  Ctrl-T         expand or collapse tool output",
  "  Alt+Up         pull the last queued message back into the editor",
  "  Ctrl-P / N     previous / next history entry",
  "  Shift+Enter    newline inside the editor (also Ctrl-J, Ctrl-O)",
  "",
  "  /help  /model  /compact  /fork  /quit",
].join("\n");
