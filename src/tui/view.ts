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
}

/** The live region: streaming text, the running tool, marker, queued messages, editor, status. */
export function liveRegion(input: RegionInput): Region {
  const content: string[] = [];
  if (input.thinking !== "") content.push(...thinkingBlock(input.thinking).split("\n"));
  if (input.stream !== "") {
    content.push(...renderStream(input.stream));
  }
  if (input.tool !== undefined) {
    content.push(`${ANSI.dim}● ${input.tool.name} ${input.tool.args} …${ANSI.reset}`);
  }
  if (input.marker !== "") content.push(`${ANSI.inverse}${input.marker}${ANSI.reset}`);
  for (const item of input.queued) {
    const tag = item.kind === "steer" ? "[steer]" : "[follow-up]";
    content.push(`${ANSI.dim}${tag}${ANSI.reset} ${item.text}`);
  }
  const editor = input.editorLines.map((line) => (line === "" ? "> " : `> ${line}`));
  if (input.editorEmpty) {
    editor.push(`${ANSI.dim}type a prompt, enter to send, enter while running to steer${ANSI.reset}`);
  }

  const viewport = input.viewportRows;
  if (viewport === undefined || viewport < 2) {
    const rows = [...content];
    const editorStart = rows.length;
    rows.push(...editor, input.status);
    return region(rows, editorStart + input.editorRow, input.editorCol + 2, input.viewportCols);
  }

  // Keep both the cursor and the status visible even when a small terminal cannot fit every draft
  // or queued row. Content is deliberately the expendable part of the live region.
  // Pi leaves roughly the bottom third quiet; keep the editor at the lower edge of the active
  // transcript instead of pinning it to the terminal's physical bottom.
  const bottomRows = Math.floor(viewport / 3);
  const activeRows = viewport - bottomRows;
  const maxEditorRows = activeRows - 1;
  const editorStartAt = Math.max(0, Math.min(input.editorRow - maxEditorRows + 1, editor.length - maxEditorRows));
  const visibleEditor = editor.slice(editorStartAt, editorStartAt + maxEditorRows);
  const contentRows = activeRows - visibleEditor.length - 1;
  const visibleContent = contentRows === 0 ? [] : content.slice(-contentRows);
  const rows = [...visibleContent, ...Array.from({ length: contentRows - visibleContent.length }, () => "")];
  const editorStart = rows.length;
  rows.push(...visibleEditor, input.status, ...Array.from({ length: bottomRows }, () => ""));
  return region(rows, editorStart + input.editorRow - editorStartAt, input.editorCol + 2, input.viewportCols);
}

/** Model reasoning is display-only: muted and distinct from the answer. */
export function thinkingBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `${ANSI.dim}${ANSI.italic}${line}${ANSI.reset}`)
    .join("\n");
}

/** Keeps a live row inside the terminal margin: terminals wrap a margin write on the next byte. */
function region(rows: string[], row: number, col: number, width: number | undefined): Region {
  if (width === undefined) return { lines: rows, row, col };
  const max = Math.max(1, width - 1);
  return { lines: rows.map((line) => clipAnsi(line, max)), row, col: Math.min(col, max) };
}

function clipAnsi(line: string, max: number): string {
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
