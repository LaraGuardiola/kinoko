// Syntax colours for code blocks: one small tokenizer driven by per-language data (comments,
// strings, keywords), not a grammar per language. It colours foreground only and resets with
// `39m`/`23m`, never a full reset, so the code panel's background survives every token.

const ESC = "\x1b[";
const FG_OFF = `${ESC}39m`;
const ITALIC_OFF = `${ESC}23m`;
const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;

// The palette follows the rest of the TUI: amanita red keywords, cream types.
export const SYNTAX = {
  keyword: rgb(236, 104, 104),
  string: rgb(166, 209, 137),
  number: rgb(239, 159, 118),
  constant: rgb(239, 159, 118),
  comment: `${ESC}3m${rgb(120, 126, 154)}`,
  fn: rgb(130, 170, 255),
  type: rgb(238, 222, 186),
  property: rgb(137, 220, 235),
  variable: rgb(245, 194, 231),
  interp: rgb(236, 104, 104), // the ${ } around an interpolated expression
  punct: rgb(170, 176, 198),
  plain: rgb(214, 218, 232),
  added: rgb(166, 209, 137),
  removed: rgb(236, 104, 104),
};

interface Spec {
  line: string[]; // line comment starters
  block?: [string, string]; // block comment delimiters
  quotes: string[]; // string delimiters; the multi-line ones may span lines
  multiline?: string[];
  keywords: Set<string>;
  constants: Set<string>;
  types?: boolean; // Capitalized identifiers are types
  builtins?: Set<string>; // lowercase type names: string, number, i32, bool...
  caseless?: boolean; // SQL
  hashComment?: "start-or-space"; // shell: `#` only starts a comment at a word boundary
  interpolate?: boolean; // `${expr}` inside backtick strings is code
  tags?: boolean; // markup: <tag> and </tag> names, attribute names (@click, :prop, v-if)
}

const words = (text: string): Set<string> => new Set(text.split(" "));

const C_LIKE: Spec = {
  line: ["//"],
  block: ["/*", "*/"],
  quotes: ["`", '"', "'"],
  multiline: ["`"],
  keywords: words(
    "abstract as async await break case catch class const continue default defer delete do else enum export extends final finally fn for from func function go if impl implements import in instanceof interface let match mod mut namespace new package private protected pub public readonly return satisfies static struct super switch this throw throws trait try type typeof use var void where while with yield",
  ),
  constants: words("true false null undefined nil None NaN Infinity self"),
  types: true,
  builtins: words(
    "string number boolean bigint symbol object any unknown never int float double char bool byte short long unsigned signed i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 str rune uint uint8 uint16 uint32 uint64 int8 int16 int32 int64 float32 float64",
  ),
  interpolate: true,
};

const SPECS: Record<string, Spec> = {
  c: C_LIKE,
  python: {
    line: ["#"],
    quotes: ['"""', "'''", '"', "'"],
    multiline: ['"""', "'''"],
    keywords: words(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield print",
    ),
    constants: words("True False None self cls"),
    types: true,
    builtins: words("int float str bool bytes list dict set tuple object"),
  },
  shell: {
    line: ["#"],
    hashComment: "start-or-space",
    quotes: ['"', "'"],
    keywords: words(
      "if then else elif fi for in do done while until case esac function return local export source alias echo cd exit set unset readonly shift eval exec sudo",
    ),
    constants: words("true false"),
  },
  sql: {
    line: ["--"],
    block: ["/*", "*/"],
    quotes: ["'", '"'],
    keywords: words(
      "select from where and or not insert into values update set delete create table drop alter add index on join left right inner outer group by order having limit offset as distinct union all primary key foreign references default case when then else end is in like between exists returning",
    ),
    constants: words("null true false"),
    caseless: true,
  },
  // HTML and the single-file components built on it (Vue, Svelte, Astro): tags and attributes, and
  // the script inside them coloured as JavaScript.
  markup: {
    line: ["//"],
    block: ["<!--", "-->"],
    quotes: ['"', "'", "`"],
    multiline: ["`"],
    keywords: C_LIKE.keywords,
    constants: C_LIKE.constants,
    types: true,
    tags: true,
    interpolate: true,
  },
  data: {
    line: ["#"],
    quotes: ['"', "'"],
    keywords: new Set(),
    constants: words("true false null yes no on off"),
  },
};

const ALIASES: Record<string, string> = {
  ts: "c", tsx: "c", typescript: "c", js: "c", jsx: "c", javascript: "c", mjs: "c", cjs: "c",
  json: "c", jsonc: "c", java: "c", go: "c", rust: "c", rs: "c", c: "c", h: "c", cpp: "c",
  "c++": "c", cs: "c", csharp: "c", swift: "c", kotlin: "c", kt: "c", php: "c", scala: "c",
  dart: "c", css: "c", scss: "c", zig: "c",
  py: "python", python: "python",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", fish: "shell",
  sql: "sql",
  yaml: "data", yml: "data", toml: "data", ini: "data", conf: "data", dockerfile: "data",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", astro: "markup",
};

/** What a highlighter carries from one line to the next: an open block comment or string. */
export interface HighlightState {
  inBlock?: boolean;
  inString?: string;
}

/** Colours one line of code. Unknown languages come back plain (still in the panel's colours). */
export function highlightLine(line: string, lang: string, state: HighlightState = {}): { text: string; state: HighlightState } {
  const name = lang.toLowerCase();
  if (name === "diff" || name === "patch") return { text: diffLine(line), state: {} };
  const spec = SPECS[ALIASES[name] ?? ""];
  if (spec === undefined) return { text: paint(SYNTAX.plain, line), state: {} };
  return tokenize(line, spec, state);
}

function diffLine(line: string): string {
  if (line.startsWith("+")) return paint(SYNTAX.added, line);
  if (line.startsWith("-")) return paint(SYNTAX.removed, line);
  if (line.startsWith("@@")) return paint(SYNTAX.property, line);
  return paint(SYNTAX.plain, line);
}

function paint(color: string, text: string): string {
  if (text === "") return "";
  return color === SYNTAX.comment ? `${color}${text}${ITALIC_OFF}${FG_OFF}` : `${color}${text}${FG_OFF}`;
}

function tokenize(line: string, spec: Spec, start: HighlightState): { text: string; state: HighlightState } {
  let out = "";
  let i = 0;
  const state: HighlightState = { ...start };
  const rest = (): string => line.slice(i);

  while (i < line.length) {
    if (state.inBlock && spec.block) {
      const end = line.indexOf(spec.block[1], i);
      const stop = end < 0 ? line.length : end + spec.block[1].length;
      out += paint(SYNTAX.comment, line.slice(i, stop));
      i = stop;
      if (end >= 0) state.inBlock = false;
      continue;
    }
    if (state.inString !== undefined) {
      const run = stringRun(line, i, state.inString, spec);
      out += run.text;
      i = run.stop;
      if (run.closed) state.inString = undefined;
      continue;
    }
    const lineComment = spec.line.find((c) => rest().startsWith(c));
    if (lineComment !== undefined && (spec.hashComment === undefined || i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      out += paint(SYNTAX.comment, rest());
      break;
    }
    if (spec.block && rest().startsWith(spec.block[0])) {
      state.inBlock = true;
      out += paint(SYNTAX.comment, spec.block[0]);
      i += spec.block[0].length;
      continue;
    }
    const quote = spec.quotes.find((q) => rest().startsWith(q));
    if (quote !== undefined) {
      const run = stringRun(line, i + quote.length, quote, spec, quote);
      if (!run.closed && spec.multiline?.includes(quote)) state.inString = quote;
      // A plain string followed by a colon is a key ({"name": ...}).
      const isKey = quote !== "`" && /^\s*:/.test(line.slice(run.stop)) && spec !== SPECS.shell && !spec.tags;
      out += isKey ? paint(SYNTAX.property, line.slice(i, run.stop)) : run.text;
      i = run.stop;
      continue;
    }
    if (spec.tags) {
      // <tag, </tag: the bracket as punctuation, the name as a keyword; an attribute before its "=".
      const tag = /^(<\/?)([A-Za-z][\w.:-]*)/.exec(rest());
      if (tag) {
        out += paint(SYNTAX.punct, tag[1] ?? "") + paint(SYNTAX.keyword, tag[2] ?? "");
        i += tag[0].length;
        continue;
      }
      const attr = /^[@:#]?[A-Za-z_][\w.:-]*(?==)/.exec(rest());
      if (attr && /[\s"'{]/.test(line[i - 1] ?? " ")) {
        out += paint(SYNTAX.property, attr[0]);
        i += attr[0].length;
        continue;
      }
    }
    const prev = line[i - 1] ?? "";
    const number = /^(0[xob][\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?n?)/i.exec(rest());
    if (number && !/[\w$]/.test(prev)) {
      out += paint(SYNTAX.number, number[0]);
      i += number[0].length;
      continue;
    }
    if (spec === SPECS.shell && line[i] === "$") {
      const variable = /^\$(\{[^}]*\}|[\w@#?*!$-]+)/.exec(rest());
      if (variable) {
        out += paint(SYNTAX.variable, variable[0]);
        i += variable[0].length;
        continue;
      }
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(rest());
    if (ident) {
      const word = ident[0];
      const key = spec.caseless ? word.toLowerCase() : word;
      const after = line.slice(i + word.length);
      let color = SYNTAX.plain;
      if (spec.keywords.has(key)) color = SYNTAX.keyword;
      else if (spec.constants.has(key)) color = SYNTAX.constant;
      else if (/^\s*\(/.test(after)) color = SYNTAX.fn;
      else if (spec.builtins?.has(word) || (spec.types && /^[A-Z]/.test(word))) color = SYNTAX.type;
      else if (prev === ".") color = SYNTAX.property;
      out += paint(color, word);
      i += word.length;
      continue;
    }
    const punct = /^[^\w\s"'`$]+/.exec(rest());
    if (punct) {
      // Stop before anything that opens a comment or a string.
      let text = punct[0];
      const cut = [...spec.line, ...(spec.block ? [spec.block[0]] : [])]
        .map((c) => text.indexOf(c))
        .filter((at) => at > 0);
      if (cut.length > 0) text = text.slice(0, Math.min(...cut));
      out += paint(SYNTAX.punct, text);
      i += text.length;
      continue;
    }
    out += line[i] ?? "";
    i++;
  }
  return { text: out, state };
}

/**
 * A string's body from `from` up to and including its closing `quote` (or the end of the line),
 * after `open` (the opening quote, when the string starts on this line).
 * Interpolations are coloured as what they are: `${expr}` in a template literal is code, and
 * `$VAR` in a shell double-quoted string is a variable.
 */
function stringRun(line: string, from: number, quote: string, spec: Spec, open = ""): { text: string; stop: number; closed: boolean } {
  let out = "";
  let chunk = open;
  let i = from;
  while (i < line.length) {
    if (line[i] === "\\") {
      chunk += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (line.startsWith(quote, i)) {
      return { text: `${out}${paint(SYNTAX.string, `${chunk}${quote}`)}`, stop: i + quote.length, closed: true };
    }
    if (quote === "`" && spec.interpolate && line.startsWith("${", i)) {
      const close = matchingBrace(line, i + 2);
      if (close >= 0) {
        const expr = tokenize(line.slice(i + 2, close), spec, {}).text;
        out += `${paint(SYNTAX.string, chunk)}${paint(SYNTAX.interp, "${")}${expr}${paint(SYNTAX.interp, "}")}`;
        chunk = "";
        i = close + 1;
        continue;
      }
    }
    if (quote === '"' && spec === SPECS.shell && line[i] === "$") {
      const variable = /^\$(\{[^}]*\}|[\w@#?*!$-]+)/.exec(line.slice(i));
      if (variable) {
        out += `${paint(SYNTAX.string, chunk)}${paint(SYNTAX.variable, variable[0])}`;
        chunk = "";
        i += variable[0].length;
        continue;
      }
    }
    chunk += line[i] ?? "";
    i++;
  }
  return { text: `${out}${paint(SYNTAX.string, chunk)}`, stop: line.length, closed: false };
}

/** Index of the `}` that closes a brace opened just before `from`; -1 when not on this line. */
function matchingBrace(line: string, from: number): number {
  let depth = 1;
  for (let i = from; i < line.length; i++) {
    if (line[i] === "{") depth++;
    else if (line[i] === "}" && --depth === 0) return i;
  }
  return -1;
}
