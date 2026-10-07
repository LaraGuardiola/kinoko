// How the live region looks: pure functions, no state. The App decides what is true, this decides
// how the rows look.

import { renderMarkdown } from "./markdown.ts";

export const STREAM_ROWS = 12; // how much streaming text stays in the live region
export const COMPACT_ROWS = 3;
export const ABORTED = "Aborted by user"; // what the Agent puts back for a cut-short tool

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

export interface RegionInput {
  transcript: Array<{ role: "user" | "assistant" | "thinking"; text: string }>;
  stream: string;
  thinking: string;
  tool: ToolView | undefined;
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
  /** Transcript head rows cut off by the viewport: the App prints them to the scrollback once. */
  dropped: string[];
}

/** The live region: streaming text, the running tool, marker, queued messages, editor, status. */
export function liveRegion(input: RegionInput): Region {
  let transcriptRows: string[] = [];
  for (const message of input.transcript) {
    const style = message.role === "user" ? ANSI.user : "";
    const prefix = message.role === "user" ? "> " : "";
    const lines = message.role === "assistant" ? renderMarkdown(message.text).split("\n") : message.text.split("\n");
    if (message.role === "thinking") transcriptRows.push(...thinkingBlock(message.text).split("\n"));
    else transcriptRows.push(...lines.map((line) => `${style}${prefix}${line}${style ? ANSI.reset : ""}`));
  }
  let tail: string[] = [];
  if (input.thinking !== "") tail.push(...thinkingBlock(input.thinking).split("\n"));
  if (input.stream !== "") {
    tail.push(...renderStream(input.stream));
  }
  if (input.tool !== undefined) {
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
    transcriptRows = transcriptRows.flatMap((line) => wrapAnsi(line, width));
    tail = tail.flatMap((line) => wrapAnsi(line, width));
    // The idle hint never holds the cursor, so it can wrap instead of ending in "…".
    if (input.editorEmpty && editor.length > 0) {
      const hint = editor.pop() as string;
      editor.push(...wrapAnsi(hint, width));
    }
  }
  const content = [...transcriptRows, ...tail];
  if (viewport === undefined || viewport < 2) {
    const rows = [...content];
    const editorStart = rows.length;
    rows.push(...editor, input.status);
    return { ...region(rows, editorStart + input.editorRow, input.editorCol + 2, input.viewportCols), dropped: [] };
  }

  // The region flows downward from the startup panel: content, then the editor
  // and status right below it, with no filler rows. Only when everything no
  // longer fits the viewport is the tail kept, which pins the editor/status
  // to the bottom while the conversation scrolls above them.
  const editorRoom = Math.max(1, viewport - 1);
  const editorStartAt = Math.max(0, Math.min(input.editorRow - editorRoom + 1, editor.length - editorRoom));
  const visibleEditor = editor.length <= editorRoom ? editor : editor.slice(editorStartAt, editorStartAt + editorRoom);
  const contentRoom = Math.max(0, viewport - visibleEditor.length - 1);
  const visibleContent = contentRoom === 0 ? [] : content.slice(-contentRoom);
  const rows = [...visibleContent, ...visibleEditor, input.status];
  const editorStart = visibleContent.length;
  // Rows of the transcript that no longer fit are reported, not hidden: the App
  // moves them to the scrollback once, so no chat is ever lost to the trim.
  const visibleTail = Math.min(tail.length, visibleContent.length);
  const dropped = transcriptRows.slice(0, Math.max(0, transcriptRows.length - (visibleContent.length - visibleTail)));
  return { ...region(rows, editorStart + input.editorRow - editorStartAt, input.editorCol + 2, input.viewportCols), dropped };
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

/** Markdown for the streaming tail; keeps only the last rows so the region stays small. */
export function renderStream(text: string): string[] {
  const lines = text.split("\n");
  const tail = lines.length <= STREAM_ROWS ? text : lines.slice(-STREAM_ROWS).join("\n");
  return renderMarkdown(tail).split("\n");
}

/** The part of a long message that has to move up into the scrollback instead of the region. */
export function overflow(text: string): string {
  const lines = text.split("\n");
  return lines.length <= STREAM_ROWS ? "" : lines.slice(0, lines.length - STREAM_ROWS).join("\n");
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
