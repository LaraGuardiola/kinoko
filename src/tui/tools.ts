// How a tool call looks: a yellow head naming the tool and what it acts on, then its output, all
// on a soft green (ok) or red (failed) band.

import { ANSI, visibleLength, wrapAnsi } from "./style.ts";
import type { ToolView } from "./view.ts";

/** Rows of tool output shown before the block collapses (ctrl+t expands). */
export const COMPACT_ROWS = 3;

/** The tool line: name in bold yellow, what it acts on in bold white. `dot` recolours the bullet. */
export function toolHead(tool: Pick<ToolView, "name" | "args">, dot: string = ANSI.toolDot): string {
  const args = tool.args === "" ? "" : ` ${ANSI.white}${tool.args}`;
  return `${dot}●${ANSI.reset} ${ANSI.tool}${tool.name}${ANSI.reset}${args}${ANSI.reset}`;
}

/** One fade in and out of the bullet of a tool in progress, in this many frames. */
const PULSE_MS = 1200;
const PULSE_STEPS = 12;
const DOT_DIM = [70, 58, 22];
const DOT_LIT = [255, 215, 95]; // the bullet's resting yellow (256-colour 221)

/** How lit the bullet is at `now`, 0..1 on a cosine, in PULSE_STEPS steps so frames stay few. */
export function pulseLevel(now: number): number {
  const step = Math.floor((now % PULSE_MS) / (PULSE_MS / PULSE_STEPS));
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * step) / PULSE_STEPS);
}

/** The bullet's colour at a pulse level: from a dim amber to the resting yellow. */
export function pulseDot(level: number): string {
  const [r, g, b] = DOT_DIM.map((dim, i) => Math.round(dim + (DOT_LIT[i]! - dim) * level));
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** What a call acts on, instead of its JSON: the path, the command, the pattern. */
export function toolSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
  let main = "";
  if (name === "read" || name === "write" || name === "edit") main = str("path");
  else if (name === "bash") main = str("command") || str("cmd");
  else if (name === "search") main = [str("pattern"), str("path")].filter((part) => part !== "").join(" in ");
  return oneLine(main === "" ? JSON.stringify(a) : main, 100);
}

/** A tool failed when it says so: an ERROR result, a non-zero exit or a timeout (see bash.ts). */
export function toolFailed(output: string): boolean {
  return output.startsWith("ERROR:") || /\n\[(exit code \d+|timed out after [^\]]*)\]$/.test(output.trimEnd());
}

/**
 * A finished tool block: collapsed to COMPACT_ROWS lines unless `full` is set. The whole block,
 * head included, sits on a soft green band when the tool succeeded and a soft red one when it
 * failed, `width` wide.
 */
export function toolBlock(tool: ToolView, full: boolean, width = 80): string {
  const head = toolHead(tool);
  if (tool.aborted) return `${head} ${ANSI.dim}aborted${ANSI.reset}`;
  const all = tool.output.replace(/\n+$/, "").split("\n");
  const shown = full ? all : all.slice(0, COMPACT_ROWS);
  // One column of padding each side, plus the renderer's own margin.
  const inner = Math.max(3, width - 4);
  // A band row above and below gives the block some air.
  const rows = [
    "",
    ...wrapAnsi(head, inner),
    ...shown.flatMap((row) => wrapAnsi(row.replace(/\t/g, "  "), inner - 2)).map((row) => `  ${row}`),
  ];
  const hidden = all.length - shown.length;
  if (hidden > 0) rows.push(`  ${ANSI.dim}… ${hidden} more lines (ctrl+t)${ANSI.reset}`);
  rows.push("");
  return band(rows, toolFailed(tool.output) ? ANSI.bgErr : ANSI.bgOk, inner);
}

/** Paints rows on a background `inner` wide; a reset inside a row must not end the band. */
function band(rows: string[], bg: string, inner: number): string {
  return rows
    .map((row) => {
      const pad = " ".repeat(Math.max(0, inner - visibleLength(row)));
      return `${bg} ${row.replaceAll(ANSI.reset, `${ANSI.reset}${bg}`)}${pad} ${ANSI.reset}`;
    })
    .join("\n");
}

/** Tool arguments on one line, trimmed: the region is narrow. */
export function oneLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
