// Markdown for a terminal: headings, lists, task lists, quotes, rules, tables, fenced code (as an
// editor pane, see code.ts) and nested inline styles. Rows come out already wrapped by word to
// `width`, lists and quotes with a hanging indent.
//
// Callers hand it whole lines. A stream is never cut inside a fence or a table (splitStable), so
// every block here is seen whole or, while it is still streaming, from its start.

import type { FenceRenderer } from "../ext.ts";
import { codeBlock, drawnBlock } from "./code.ts";
import { isTableStart, renderTable } from "./table.ts";
import { visibleLength, wrapWords } from "./style.ts";
import { isTreeLine, treeRows } from "./tree.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const STRIKE = `${ESC}9m`;
const DIM = `${ESC}2m`;
const CODE = `${ESC}38;2;137;220;235m`;
const RED = `${ESC}38;2;232;36;36m`;
const CREAM = `${ESC}38;2;238;222;186m`;
const QUOTE = `${ESC}38;2;150;156;182m`;
const LINK_URL = `${ESC}38;2;120;126;154m`;

export interface MarkdownOptions {
  /** ANSI colour off for plain logs and tests. */
  color?: boolean;
  /** Columns available; rows are wrapped to it. */
  width?: number;
}

/** A fence opener: ``` or ~~~ (three or more), optionally followed by a language. */
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;

/** Who draws a fence's language instead of showing it as code (extensions: ```mermaid). */
let fences: (lang: string) => FenceRenderer | undefined = () => undefined;

export function setFenceRenderers(lookup: (lang: string) => FenceRenderer | undefined): void {
  fences = lookup;
}

// A drawing is redone on every frame while the reply streams: the last ones are kept, per renderer.
const drawings = new WeakMap<FenceRenderer, Map<string, string[] | undefined>>();

/** A closed fence drawn by its renderer, or undefined (none, it gave up, it threw, too wide). */
function drawn(lang: string, source: string, width: number): string[] | undefined {
  const render = fences(lang);
  if (render === undefined) return undefined;
  const seen = drawings.get(render) ?? new Map<string, string[] | undefined>();
  drawings.set(render, seen);
  const key = `${width}\n${source}`;
  if (!seen.has(key)) {
    let rows: string[] | undefined;
    try {
      rows = render(source, width);
    } catch {
      rows = undefined; // a broken renderer shows the source, never breaks the transcript
    }
    if (rows?.some((row) => visibleLength(row) > width)) rows = undefined;
    if (seen.size >= 16) seen.delete(seen.keys().next().value ?? "");
    seen.set(key, rows);
  }
  return seen.get(key);
}

export function renderMarkdown(text: string, opts: MarkdownOptions = {}): string {
  const color = opts.color ?? true;
  const width = Math.max(10, opts.width ?? 80);
  const style = (code: string, body: string): string => (color ? `${code}${body}${RESET}` : body);
  const fmt = (line: string, outer = ""): string => (color ? inline(line, outer) : plainInline(line));
  const lines = text.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      let end = i + 1;
      while (end < lines.length && !isClosing(lines[end] ?? "", marker)) end++;
      const lang = fence[2] ?? "";
      const body = lines.slice(i + 1, end);
      // Still streaming (no closing fence yet): the source, drawn once it is whole.
      const rows = color && end < lines.length ? drawn(lang, body.join("\n"), width - 3) : undefined;
      out.push(...(rows === undefined ? codeBlock(body, { lang, width, color }) : drawnBlock(rows, { lang, width })));
      i = end + 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      let end = i + 2;
      while (end < lines.length && (lines[end] ?? "").includes("|") && (lines[end] ?? "").trim() !== "") end++;
      out.push(...renderTable(lines.slice(i, end), width, (cell) => fmt(cell), color));
      i = end;
      continue;
    }

    // A directory tree outside a fence: kept aligned, never read as markdown (__init__.py).
    if (isTreeLine(lines[i + 1] ?? "") && (isTreeLine(line) || /^\S+\/$/.test(line.trim()))) {
      let end = i + 1;
      while (end < lines.length && isTreeLine(lines[end] ?? "")) end++;
      out.push(...treeRows(lines.slice(i, end), width, color));
      i = end;
      continue;
    }
    i++;

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const look = level === 1 ? `${BOLD}${RED}` : level === 2 ? `${BOLD}${CREAM}` : BOLD;
      const rows = wrapWords(fmt(heading[2] ?? "", look), width);
      out.push(...rows.map((row) => style(look, row)));
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(style(DIM, "─".repeat(width)));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const bar = style(QUOTE, "│ ");
      const rows = wrapWords(`${bar}${fmt(quote[1] ?? "", `${ITALIC}${QUOTE}`)}`, width, bar);
      out.push(...rows.map((row) => (color ? `${row.replace(bar, `${bar}${ITALIC}${QUOTE}`)}${RESET}` : row)));
      continue;
    }

    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      const indent = " ".repeat(Math.min(12, (item[1] ?? "").length));
      const marker = item[2] ?? "-";
      const ordered = /\d/.test(marker);
      let bullet = ordered ? style(CREAM, marker) : style(RED, "•");
      const task = item[3]?.trim();
      if (task !== undefined) bullet = task === "[ ]" ? style(DIM, "☐") : style(RED, "☑");
      const prefix = `${indent}${bullet} `;
      const hang = " ".repeat(visibleLength(prefix));
      out.push(...wrapWords(`${prefix}${fmt(item[4] ?? "")}`, width, hang));
      continue;
    }

    out.push(...wrapWords(fmt(line), width));
  }
  return out.join("\n");
}

/** The marker (``` or ~~~...) when `line` opens a fence. */
export function fenceOpener(line: string): string | undefined {
  return FENCE.exec(line)?.[1];
}

export function isClosing(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marker) && /^[`~]+$/.test(trimmed) && trimmed[0] === marker[0];
}

/**
 * Inline spans, nested: `code`, **bold**, *italic*, _italic_, ~~strike~~, [text](url) and
 * backslash escapes. `outer` is the style the caller's row is in: every span re-opens it after its
 * reset, so a span inside a heading keeps the heading's colour.
 */
export function inline(text: string, outer = ""): string {
  let out = "";
  let i = 0;
  const span = (style: string, inner: string): string => `${style}${inline(inner, `${outer}${style}`)}${RESET}${outer}`;
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i] ?? "";
    if (ch === "\\" && /^\\[\\`*_~[\]()#|>-]/.test(rest)) {
      out += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`";
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > 0) {
        out += `${CODE}${text.slice(i + ticks.length, close).trim()}${RESET}${outer}`;
        i = close + ticks.length;
        continue;
      }
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      out += `${span(UNDERLINE, link[1] ?? "")}${link[1] === link[2] ? "" : ` ${LINK_URL}(${link[2]})${RESET}${outer}`}`;
      i += link[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong && (strong[1] === "**" || boundary(text, i, strong[0].length))) {
      out += span(BOLD, strong[2] ?? "");
      i += strong[0].length;
      continue;
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      out += span(STRIKE, strike[1] ?? "");
      i += strike[0].length;
      continue;
    }
    const em = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?!\1)/.exec(rest);
    if (em && (em[1] === "*" || boundary(text, i, em[0].length))) {
      out += span(ITALIC, em[2] ?? "");
      i += em[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `_x_` only counts at word boundaries, so snake_case_names stay as they are. */
function boundary(text: string, start: number, length: number): boolean {
  return !/\w/.test(text[start - 1] ?? "") && !/\w/.test(text[start + length] ?? "");
}

/** The same markup with the markers dropped, for colourless output. */
function plainInline(text: string): string {
  const ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return inline(text).replace(ESCAPE, "");
}
