import { afterAll, describe, expect, test } from "bun:test";
import type { Tool } from "../../src/types.ts";
import install, { decodeEntities, fetchPage, htmlToText, parseBing, parseBrave, parseDuckDuckGo, search } from "./web.ts";
import type { Engine } from "./web.ts";

const signal = new AbortController().signal;

// A local web: pages for web_fetch, and two "engines" for the fallback chain. No real network.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/page") {
      return new Response(
        `<html><head><title>A &amp; B</title><style>x{}</style></head><body><nav>menu</nav>
         <main><h1>Hello</h1><p>One&nbsp;two <b>three</b></p><ul><li>first</li><li>second</li></ul>
         <script>alert(1)</script></main><footer>legal</footer></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (path === "/long") return new Response("x".repeat(30_000), { headers: { "content-type": "text/plain" } });
    if (path === "/json") return Response.json({ ok: true });
    if (path === "/image") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (path === "/blocked") return new Response("bot check", { status: 202 });
    if (path === "/results") {
      return new Response('<li class="b_algo"><h2><a href="https://example.com/a">Result A</a></h2><p class="b_lineclamp2">About A</p></li>');
    }
    return new Response("missing", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

describe("web extension: parsing", () => {
  test("entities, named and numeric", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#243; &#x41; &nbsp;&unknown;")).toBe("a & b <c> ó A  &unknown;");
  });

  test("Brave: plain link, title div, snippet; escaped highlighting is dropped", () => {
    const html = `<div class="snippet" data-type="web"><a href="https://bun.com/docs" target="_self">
      <div class="title search-snippet-title line-clamp-1" title="x">Bun &amp; Docs</div></a>
      <div class="content desktop-default-regular">Fast &lt;strong&gt;runtime&lt;/strong&gt;</div></div>`;
    expect(parseBrave(html)).toEqual([{ title: "Bun & Docs", url: "https://bun.com/docs", snippet: "Fast runtime" }]);
  });

  test("DuckDuckGo: the real URL comes out of the uddg redirect; ads are skipped", () => {
    const html = `<div class="result results_links result--ad"><a class="result__a" href="//ad">Ad</a></div>
      <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.com%2Fdocs&amp;rut=1">Bun Docs</a>
      <a class="result__snippet" href="x">The <b>docs</b></a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Bun Docs", url: "https://bun.com/docs", snippet: "The docs" }]);
  });

  test("Bing: the real URL is the base64url in u=a1…", () => {
    const encoded = Buffer.from("https://bun.com/docs").toString("base64url");
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;p=1&amp;u=a1${encoded}&amp;ntb=1">Bun</a></h2>
      <p class="b_lineclamp2">Runtime</p></li>`;
    expect(parseBing(html)).toEqual([{ title: "Bun", url: "https://bun.com/docs", snippet: "Runtime" }]);
  });

  test("HTML to text: main content only, headings and list items marked, no scripts", () => {
    const { title, text } = htmlToText(
      "<title>T</title><nav>menu</nav><main><h2>Head</h2><p>a&amp;b</p><ul><li>x</li><li>y</li></ul><script>bad()</script></main>",
    );
    expect(title).toBe("T");
    expect(text).toBe("## Head\n\na&b\n\n- x\n- y");
  });
});

describe("web extension: tools", () => {
  test("web_fetch reads a page as text: title, main content, no chrome", async () => {
    const out = await fetchPage(`${base}/page`, 0, signal);
    expect(out).toContain("Title: A & B");
    expect(out).toContain("# Hello");
    expect(out).toContain("One two three");
    expect(out).toContain("- first\n- second");
    for (const gone of ["menu", "legal", "alert", "x{}"]) expect(out).not.toContain(gone);
  });

  test("web_fetch pages long text with the offset to continue from", async () => {
    const first = await fetchPage(`${base}/long`, 0, signal);
    expect(first).toContain("[chars 0-12000 of 30000; continue with offset=12000]");
    const last = await fetchPage(`${base}/long`, 24_000, signal);
    expect(last).not.toContain("continue with offset");
  });

  test("web_fetch: JSON as-is; binaries, HTTP errors and non-http URLs are tool errors", async () => {
    expect(await fetchPage(`${base}/json`, 0, signal)).toContain('{"ok":true}');
    expect(await fetchPage(`${base}/image`, 0, signal)).toStartWith("ERROR:");
    expect(await fetchPage(`${base}/nope`, 0, signal)).toContain("HTTP 404");
    expect(await fetchPage("file:///etc/passwd", 0, signal)).toStartWith("ERROR:");
  });

  test("web_search falls through an engine's bot check (202) to the next one", async () => {
    const engines: Engine[] = [
      { name: "first", url: () => `${base}/blocked`, parse: parseBrave },
      { name: "second", url: () => `${base}/results`, parse: parseBing },
    ];
    const out = await search("anything", 5, signal, engines);
    expect(out).toContain("1. Result A\n   https://example.com/a\n   About A");
    expect(out).toContain("(via second;");
    const none = await search("anything", 5, signal, engines.slice(0, 1));
    expect(none).toStartWith("ERROR: web_search found nothing (first: HTTP 202)");
  });

  test("an aborted signal stops a fetch", async () => {
    const cut = new AbortController();
    cut.abort();
    await expect(fetchPage(`${base}/page`, 0, cut.signal)).rejects.toThrow();
  });

  test("installs two read-only tools", () => {
    const tools: Tool[] = [];
    install({ registerTool: (t: Tool) => tools.push(t), on: () => undefined, registerCommand: () => undefined, log: () => undefined });
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([["web_search", true], ["web_fetch", true]]);
  });
});
