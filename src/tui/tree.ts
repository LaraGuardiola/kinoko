// Directory trees (`tree` output, or the ones models draw): guides dimmed, folders coloured,
// comments set apart, ASCII guides (|-- `--) drawn as box lines. A row too long for the width
// wraps under its own name, the guides kept, so the tree never breaks apart.

import { wrapWords } from "./style.ts";

const ESC = "\x1b[";
const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
// Foreground resets only: inside a code panel its background must survive.
const OFF = `${ESC}39m${ESC}22m${ESC}23m`;
const GUIDE = rgb(92, 98, 124);
const FOLDER = `${ESC}1m${rgb(130, 170, 255)}`;
const COMMENT = `${ESC}3m${rgb(120, 126, 154)}`;

const CONNECTOR = /├──?|└──?|\|--|`--|\+--|\\--/;
/** Where a comment starts after a name: `# why`, `// why`, `← why`, or two spaces. */
const COMMENT_START = /\s+(?=(?:#|\/\/|←|<-+|-->?)\s)|\s{2,}(?=\S)/;

/** A line of a tree: guides (│ or |, spaces) then a connector (├── └── |-- `--) and a name. A box
 *  drawn in text is not one: its ├────┤ runs on in line, and its rows end on a border (│ ┤ ┐ ┘). */
export function isTreeLine(line: string): boolean {
  const at = CONNECTOR.exec(line);
  if (at === null || !/^[\s│|]*$/.test(line.slice(0, at.index))) return false;
  const rest = line.slice(at.index + at[0].length);
  return /^\s*[^\s─━│┃┤┐┘┼┬┴═║]/.test(rest) && !/[│┃┤┐┘║]\s*$/.test(rest);
}

/** A fence holds a tree when at least two of its lines are tree lines. */
export function isTree(lines: string[]): boolean {
  return lines.filter(isTreeLine).length >= 2;
}

interface Row {
  guides: string;
  connector: string;
  name: string;
  comment: string;
  /** The spaces before the comment, as written: models line their comments up. */
  gap: string;
  depth: number;
}

function parse(line: string): Row {
  const at = CONNECTOR.exec(line);
  if (at === null || !isTreeLine(line)) return { guides: "", connector: "", ...split(line.trim()), depth: -1 };
  const guides = line.slice(0, at.index).replaceAll("|", "│");
  const last = at[0].startsWith("└") || at[0].startsWith("`") || at[0].startsWith("\\");
  const connector = last ? "└── " : "├── ";
  return { guides, connector, ...split(line.slice(at.index + at[0].length).trim()), depth: guides.length };
}

function split(rest: string): { name: string; comment: string; gap: string } {
  const cut = COMMENT_START.exec(rest);
  if (cut === null || cut.index === 0) return { name: rest, comment: "", gap: "" };
  return { name: rest.slice(0, cut.index), comment: rest.slice(cut.index + cut[0].length), gap: cut[0] };
}

/** The tree's rows, each at most `width` columns. */
export function treeRows(lines: string[], width: number, color = true): string[] {
  const rows = lines.map(parse);
  const paint = (style: string, text: string): string => (color && text !== "" ? `${style}${text}${OFF}` : text);
  return rows.flatMap((row, i) => {
    // A folder: says so with a slash, or the next row sits deeper.
    const next = rows[i + 1];
    const folder = row.name.endsWith("/") || (next !== undefined && next.depth > row.depth);
    const name = folder ? paint(FOLDER, row.name) : row.name;
    const text = `${paint(GUIDE, `${row.guides}${row.connector}`)}${name}${row.comment ? `${row.gap}${paint(COMMENT, row.comment)}` : ""}`;
    // Continuation rows: the guides go on (├── becomes │), two columns deeper than the name.
    const under = `${row.guides}${row.connector.startsWith("├") ? "│   " : row.connector === "" ? "" : "    "}  `;
    return wrapWords(text, width, paint(GUIDE, under));
  });
}
