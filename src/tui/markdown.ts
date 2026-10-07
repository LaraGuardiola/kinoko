// Just enough markdown for a terminal: fenced code blocks, bold and inline code.
// Callers hand it whole lines (finished blocks, or the live tail of a stream cut at a line boundary).

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;

export interface MarkdownOptions {
  /** ANSI colour off for plain logs and tests. */
  color?: boolean;
  /** The text starts inside a ``` fence (the head of that code block was already printed). */
  inFence?: boolean;
}

/** Renders markdown to ANSI. Fenced blocks are dimmed and keep their text verbatim. */
export function renderMarkdown(text: string, opts: MarkdownOptions = {}): string {
  const color = opts.color ?? true;
  const paint = (code: string, body: string): string => (color ? `${code}${body}${RESET}` : body);
  const lines = text.split("\n");
  const out: string[] = [];

  let inFence = opts.inFence ?? false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(paint(DIM, line));
      continue;
    }
    // Inside a fence nothing is inline-formatted: code must stay code.
    out.push(inFence ? paint(DIM, line) : inline(line, paint));
  }
  return out.join("\n");
}

/** Bold `**x**` and inline `code`, on one line. */
function inline(line: string, paint: (code: string, body: string) => string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf("`", i);
    const star = line.indexOf("**", i);
    const next = first(tick, star);
    if (next < 0) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, next);
    if (next === tick) {
      const close = line.indexOf("`", next + 1);
      if (close < 0) {
        out += line.slice(next);
        break;
      }
      out += paint(CYAN, line.slice(next + 1, close));
      i = close + 1;
      continue;
    }
    const close = line.indexOf("**", next + 2);
    if (close < 0) {
      out += line.slice(next);
      break;
    }
    out += paint(BOLD, line.slice(next + 2, close));
    i = close + 2;
  }
  return out;
}

function first(a: number, b: number): number {
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}