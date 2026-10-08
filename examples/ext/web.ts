// Web: lets the agent look things up. Two read-only tools, no API key, no dependency.
//   web_search  scrapes Brave Search's HTML page, then DuckDuckGo's, then Bing's, until one answers
//               with results (they rate-limit scrapers in turn). Each gives title, real URL, snippet.
//   web_fetch   downloads one page and turns it into readable text, paged like `read`.
// Copy to ~/.kinoko/ext/web.ts to switch it on; delete the file to switch it off.

import type { Kinoko } from "../../src/ext.ts";
import type { ToolContext } from "../../src/types.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
/** A web server that never answers must not hold the run; Esc still cuts it sooner. */
const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 8;
/** ~3k tokens per page of a fetched document. */
const PAGE_CHARS = 12_000;
/** Engines send whole paragraphs; a result only needs enough to choose what to fetch. */
const SNIPPET_CHARS = 300;

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Tags stripped, entities decoded, whitespace folded: one clean line. Engines also send some
 *  highlighting escaped (&lt;strong&gt;), so those few tags go again after decoding. */
function inline(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/<\/?(strong|b|em|i|span)>/gi, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Brave Search's results: plain links, the title in its own div, the snippet in "content". */
export function parseBrave(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split('data-type="web"').slice(1)) {
    const url = /<a href="(https?:\/\/[^"]+)"/.exec(block)?.[1];
    const title = /class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
    if (!url || title === undefined) continue;
    const snippet = /class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    hits.push({ title: inline(title), url: decodeEntities(url), snippet: inline(snippet) });
  }
  return hits;
}

/** DuckDuckGo's HTML results: links go through its /l/?uddg= redirect, which holds the real URL. */
export function parseDuckDuckGo(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    if (block.includes("result--ad")) continue;
    const link = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = decodeEntities(link[1] ?? "");
    const real = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    const url = real ? decodeURIComponent(real) : href.startsWith("//") ? `https:${href}` : href;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
    hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
  }
  return hits;
}

/** Bing's results: links go through /ck/a?...&u=a1<base64url of the real URL>. */
export function parseBing(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const raw of html.split('<li class="b_algo"').slice(1)) {
    const block = raw.slice(0, raw.indexOf("</li>"));
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = decodeEntities(link[1] ?? "");
    const encoded = /[?&]u=a1([^&]+)/.exec(href)?.[1];
    const url = encoded ? Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString() : href;
    const snippet = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "";
    hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
  }
  return hits;
}

/** An HTML page as readable text: the main content, headings and list items marked, no markup. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = inline(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  // The page's own main content when it says where it is; navigation and chrome otherwise go.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  const body = main
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|h[1-6]|ul|ol|table|tr|pre|blockquote)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

async function get(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...init.headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    redirect: "follow",
  });
}

export interface Engine {
  name: string;
  url: (q: string) => string;
  parse: (html: string) => Hit[];
}

const ENGINES: Engine[] = [
  { name: "brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, parse: parseBrave },
  { name: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo },
  { name: "bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
];

/** The first engine that answers with results wins; a bot check (202) or an empty page moves on. */
export async function search(query: string, max: number, signal: AbortSignal, engines = ENGINES): Promise<string> {
  const failures: string[] = [];
  for (const engine of engines) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- engines are a fallback chain, one at a time by design
      const res = await get(engine.url(query), signal);
      // oxlint-disable-next-line no-await-in-loop -- same chain: the body of the engine just asked
      const hits = res.status === 200 ? engine.parse(await res.text()).slice(0, max) : [];
      if (hits.length > 0) {
        const rows = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${clip(h.snippet)}` : ""}`);
        return `${rows.join("\n")}\n\n(via ${engine.name}; read a result with web_fetch)`;
      }
      failures.push(`${engine.name}: ${res.status === 200 ? "no results" : `HTTP ${res.status}`}`);
    } catch (e) {
      if (signal.aborted) throw e;
      failures.push(`${engine.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `ERROR: web_search found nothing (${failures.join("; ")}). Try other words, or web_fetch a known URL.`;
}

function clip(text: string): string {
  return text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`;
}

/** One page of a document, with the offset to continue from when more follows. */
function page(text: string, offset: number): string {
  const end = Math.min(text.length, offset + PAGE_CHARS);
  const more = end < text.length ? `\n\n[chars ${offset}-${end} of ${text.length}; continue with offset=${end}]` : "";
  return text.slice(offset, end) + more;
}

export async function fetchPage(url: string, offset: number, signal: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "ERROR: web_fetch needs an http(s) URL";
  const res = await get(url, signal, { headers: { accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" } });
  if (!res.ok) return `ERROR: web_fetch: HTTP ${res.status} for ${url}`;
  const type = res.headers.get("content-type") ?? "";
  const head = `URL: ${res.url || url}\n`;
  if (/html|xml/i.test(type) || type === "") {
    const { title, text } = htmlToText(await res.text());
    return `${head}${title ? `Title: ${title}\n` : ""}\n${page(text, offset)}`;
  }
  if (/^text\/|json|javascript|yaml|toml|csv/i.test(type)) return `${head}\n${page(await res.text(), offset)}`;
  return `ERROR: web_fetch: ${url} is ${type}, not text`;
}

function count(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(0, Math.trunc(raw))) : fallback;
}

export default function (k: Kinoko): void {
  k.registerTool({
    name: "web_search",
    description: "Search the web (no API key). Returns numbered results: title, URL, snippet. Read one with web_fetch.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "what to search for" },
        max: { type: "number", description: `results to return (default ${MAX_RESULTS})` },
      },
      required: ["query"],
    },
    readOnly: true,
    run: async (args: { query?: unknown; max?: unknown }, ctx: ToolContext) => {
      if (typeof args.query !== "string" || args.query.trim() === "") return "ERROR: web_search: missing query (string)";
      return search(args.query.trim(), Math.max(1, count(args.max, MAX_RESULTS, 20)), ctx.signal);
    },
  });

  k.registerTool({
    name: "web_fetch",
    description: `Fetch a web page as readable text (HTML is converted; JSON and plain text as-is). Long pages come ${PAGE_CHARS} chars at a time: pass offset to continue.`,
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL" },
        offset: { type: "number", description: "character offset to start from (default 0)" },
      },
      required: ["url"],
    },
    readOnly: true,
    run: async (args: { url?: unknown; offset?: unknown }, ctx: ToolContext) => {
      if (typeof args.url !== "string") return "ERROR: web_fetch: missing url (string)";
      return fetchPage(args.url.trim(), count(args.offset, 0, Number.MAX_SAFE_INTEGER), ctx.signal);
    },
  });
}
