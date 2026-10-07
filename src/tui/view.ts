// How the live region looks: pure functions, no state. The App decides what is true, this decides
// how the rows look.
//
// Model of the screen: everything that is FINISHED lives in the terminal's own scrollback, in the
// order it happened (user, thinking, answer, tool, thinking, answer...). The live region only
// holds what is still moving: the one block being streamed, the running tool, queued messages,
// the editor and the status line.

import { renderMarkdown } from "./markdown.ts";

/** Rows of streaming text kept in the live region before the stable part moves to scrollback. */
export const STREAM_ROWS = 12;
export const COMPACT_ROWS = 3;
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
  input: number;
  output: number;
  cacheRead: number;
}

/** The block that is being streamed right now. At most one exists at any time. */
export interface OpenBlock {
  kind: "thinking" | "assistant";
  text: string;
  /** A blank row goes before it (it follows another block). */
  gap: boolean;
  /** The text starts inside a ``` fence (a code block that was cut while streaming). */
  inFence: boolean;
}

export interface RegionInput {
  open: OpenBlock | undefined;
  tool: ToolView | undefined;
  /** A blank row goes before the running tool line. */
  toolGap?: boolean;
  marker: string;
  queued: QueuedView[];
  editorLines: string[];
  editorEmpty: boolean;
  editorRow: number;
  editorCol: number;
  status: string;
  viewportRows?: number;
  viewportCols?: number;
}

export interface Region {
  lines: string[];
  row: number;
  col: number;
}

/** A finished block as terminal rows. Used both for scrollback and for the open block. */
export function formatBlock(kind: BlockKind, text: string, inFence = false): string {
  const body = inFence ? text.replace(/\n+$/, "") : text.replace(/^\n+|\n+$/g, "");
  if (body === "") return "";
  switch (kind) {
    case "user":
      return body
        .split("\n")
        .map((line) => `${ANSI.user}> ${line}${ANSI.reset}`)
        .join("\n");
    case "thinking":
      return thinkingBlock(body);
    case "assistant":
      return renderMarkdown(body, { inFence: inFence });
    default:
      return body;
  }
}

/**
 * Streaming text that has grown past STREAM_ROWS: splits it into a part that is stable (moves to
 * the scrollback, once, in order) and the rest (stays live). Cuts at the last paragraph boundary
 * outside a code fence; a paragraph or code block taller than the region is cut by line, and
 * `restInFence` tells the renderer the rest continues inside a fence.
 * Returns undefined while everything still fits.
 */
export function splitStable(
  text: string,
  cols: number | undefined,
  startsInFence = false,
  limit = STREAM_ROWS,
): { commit: string; rest: string; gap: boolean; restInFence: boolean } | undefined {
  const width = Math.max(1, (cols ?? 80) - 2);
  const lines = text.split("\n");
  const rowsOf = (line: string): number => Math.max(1, Math.ceil(line.length / width));
  const total = lines.reduce((sum, line) => sum + rowsOf(line), 0);
  if (total <= limit || lines.length < 2) return undefined;

  // inFenceAt[i]: are we inside a ``` fence just before line i?
  const inFenceAt: boolean[] = [];
  let fence = startsInFence;
  for (const line of lines) {
    inFenceAt.push(fence);
    if (line.trimStart().startsWith("```")) fence = !fence;
  }
  const restRows = (from: number): number => lines.slice(from).reduce((sum, line) => sum + rowsOf(line), 0);

  // Preferred: everything before the paragraph that is being written now.
  for (let cut = lines.length - 1; cut >= 1; cut--) {
    if (lines[cut - 1]?.trim() !== "" || inFenceAt[cut]) continue;
    if (restRows(cut) > limit) break; // the live paragraph alone is too tall: cut by line instead
    return {
      commit: lines.slice(0, cut).join("\n").replace(/\n+$/, ""),
      rest: lines.slice(cut).join("\n"),
      gap: true,
      restInFence: false,
    };
  }

  // Fallback: keep roughly half the region as the live tail.
  const keep = Math.ceil(limit / 2);
  let cut = lines.length - 1;
  let rows = rowsOf(lines[cut] ?? "");
  while (cut > 1 && rows + rowsOf(lines[cut - 1] ?? "") <= keep) {
    cut--;
    rows += rowsOf(lines[cut] ?? "");
  }
  return {
    commit: lines.slice(0, cut).join("\n"),
    rest: lines.slice(cut).join("\n"),
    gap: false,
    restInFence: inFenceAt[cut] === true,
  };
}

/** The live region: the open block, the running tool, marker, queued messages, editor, status. */
export function liveRegion(input: RegionInput): Region {
  let tail: string[] = [];
  const open = input.open;
  if (open !== undefined) {
    const text = formatBlock(open.kind, open.text, open.inFence);
    if (text !== "") {
      if (open.gap) tail.push("");
      tail.push(...text.split("\n"));
    }
  }
  if (input.tool !== undefined) {
    if (input.toolGap) tail.push("");
    tail.push(`${ANSI.dim}● ${input.tool.name} ${input.tool.args} …${ANSI.reset}`);
  }
  if (input.marker !== "") tail.push(`${ANSI.inverse}${input.marker}${ANSI.reset}`);
  for (const item of input.queued) {
    const tag = item.kind === "steer" ? "[steer]" : "[follow-up]";
    tail.push(`${ANSI.dim}${tag}${ANSI.reset} ${item.text}`);
  }
  const editor = input.editorLines.map((line) => (line === "" ? "> " : `> ${line}`));
  if (input.editorEmpty) {
    editor.push(`${ANSI.dim}type a prompt, enter to send, enter while running to steer${ANSI.reset}`);
  }

  const viewport = input.viewportRows;
  const width = input.viewportCols === undefined ? undefined : Math.max(1, input.viewportCols - 2);
  if (width !== undefined) {
    tail = tail.flatMap((line) => wrapAnsi(line, width));
    // The idle hint never holds the cursor, so it can wrap instead of ending in "…".
    if (input.editorEmpty && editor.length > 0) {
      const hint = editor.pop() as string;
      editor.push(...wrapAnsi(hint, width));
    }
  }
  if (viewport === undefined || viewport < 2) {
    const rows = [...tail];
    const editorStart = rows.length;
    rows.push(...editor, input.status);
    return region(rows, editorStart + input.editorRow, input.editorCol + 2, input.viewportCols);
  }

  // The region must stay shorter than the terminal, or its top scrolls out of reach and cannot be
  // repainted. When the tail does not fit, only its last rows are shown: the rest of a streamed
  // block was already moved to the scrollback by splitStable, so this only trims extremes.
  const editorRoom = Math.max(1, viewport - 1);
  const editorStartAt = Math.max(0, Math.min(input.editorRow - editorRoom + 1, editor.length - editorRoom));
  const visibleEditor = editor.length <= editorRoom ? editor : editor.slice(editorStartAt, editorStartAt + editorRoom);
  const contentRoom = Math.max(0, viewport - visibleEditor.length - 1);
  const visibleTail = contentRoom === 0 ? [] : tail.slice(-contentRoom);
  const rows = [...visibleTail, ...visibleEditor, input.status];
  return region(rows, visibleTail.length + input.editorRow - editorStartAt, input.editorCol + 2, input.viewportCols);
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

/** Wraps a styled row to the terminal width, keeping ANSI colors across the split rows. */
export function wrapAnsi(line: string, max: number): string[] {
  if (max < 1) return [line];
  if (visibleLength(line) <= max) return [line];
  const rows: string[] = [];
  let cur = "";
  let visible = 0;
  let active = "";
  let index = 0;
  while (index < line.length) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        const sequenceEnd = index + end + 3;
        const seq = line.slice(index, sequenceEnd);
        cur += seq;
        if (seq.endsWith("m")) active = seq === ANSI.reset ? "" : active + seq;
        index = sequenceEnd;
        continue;
      }
    }
    if (visible >= max) {
      rows.push(active === "" ? cur : `${cur}${ANSI.reset}`);
      cur = active;
      visible = 0;
      continue;
    }
    cur += line[index] ?? "";
    visible++;
    index++;
  }
  rows.push(cur);
  return rows;
}

function visibleLength(line: string): number {
  let visible = 0;
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        index += end + 3;
        continue;
      }
    }
    visible++;
    index++;
  }
  return visible;
}

function clipAnsi(line: string, max: number): string {
  // Rows that already fit (including wrapped transcript rows) pass through untouched:
  // only truly overlong rows are cut, so a trailing reset can never trigger the ellipsis.
  if (visibleLength(line) <= max) return line;
  let out = "";
  let visible = 0;
  for (let index = 0; index < line.length;) {
    if (line.startsWith("\x1b[", index)) {
      const end = line.slice(index + 2).search(/[@-~]/);
      if (end >= 0) {
        const sequenceEnd = index + end + 3;
        out += line.slice(index, sequenceEnd);
        index = sequenceEnd;
        continue;
      }
    }
    if (visible >= max - 1 && index < line.length - 1) return `${out}…${ANSI.reset}`;
    out += line[index] ?? "";
    visible++;
    index++;
  }
  return out;
}

/** A finished tool block: collapsed to COMPACT_ROWS lines unless `full` is set. */
export function toolBlock(tool: ToolView, full: boolean): string {
  const head = `${ANSI.dim}● ${tool.name}${tool.args === "" ? "" : ` ${tool.args}`}${ANSI.reset}`;
  if (tool.aborted) return `${head} ${ANSI.dim}aborted${ANSI.reset}`;
  const all = tool.output.split("\n");
  const shown = full ? all : all.slice(0, COMPACT_ROWS);
  const body = shown.map((row) => `  ${ANSI.dim}${row}${ANSI.reset}`).join("\n");
  const hidden = all.length - shown.length;
  const hint = hidden > 0 ? `\n  ${ANSI.dim}… ${hidden} more lines (ctrl+t)${ANSI.reset}` : "";
  return `${head}\n${body}${hint}`;
}

export function statusLine(parts: {
  running: boolean;
  model: string;
  tokens: Tokens;
  contextWindow: number;
  cost: number;
}): string {
  const used = parts.tokens.input + parts.tokens.output;
  const cache = parts.tokens.input > 0 ? Math.round((parts.tokens.cacheRead / parts.tokens.input) * 100) : 0;
  return [
    parts.running ? `${ANSI.inverse} RUNNING ${ANSI.reset}` : " IDLE ",
    parts.model,
    `${used.toLocaleString("en-US")}/${parts.contextWindow.toLocaleString("en-US")} tok`,
    `cache ${cache}%`,
    parts.cost > 0 ? `$${parts.cost.toFixed(4)}` : "",
  ]
    .filter((part) => part !== "")
    .join(`${ANSI.dim} | ${ANSI.reset}`);
}

/** Tool arguments on one line, trimmed: the region is narrow. */
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** Hard wraps a logical editor line to the terminal width. */
export function wrapTo(width: number): (line: string) => string[] {
  return (line: string) => (line.length <= width ? [line] : (line.match(new RegExp(`.{1,${width}}`, "g")) ?? [line]));
}

const ESC = "\x1b[";
const ANSI = {
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  reset: `${ESC}0m`,
  inverse: `${ESC}7m`,
  user: `${ESC}38;5;159m`,
};

export const HELP = [
  "kinoko keys",
  "",
  "  Enter          send as prompt (idle) / steer (running)",
  "  Alt+Enter      follow-up (running) / send as prompt (idle)",
  "  Esc            abort the run (nothing when idle)",
  "  Ctrl-C         abort / clear the editor / quit on a second press",
  "  Ctrl-D         quit when the editor is empty",
  "  Ctrl-T         expand or collapse tool output",
  "  Alt+Up         pull the last queued message back into the editor",
  "  Ctrl-P / N     previous / next history entry",
  "  Ctrl-O         newline inside the editor",
  "",
  "  /help  /model  /compact  /fork  /quit",
].join("\n");
