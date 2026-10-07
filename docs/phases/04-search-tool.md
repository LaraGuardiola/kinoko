# Phase 4: the `search` tool (Kinoko's signature)

Read first: AGENTS.md, docs/PROGRESS.md, src/types.ts, src/tools/budget.ts.

## Create `src/tools/search.ts` and `src/tools/search-backends.ts`
One tool replaces grep + glob + find. readOnly: true.
Schema: { pattern: string, mode?: "content" | "files", path?: string, glob?: string,
context?: number, max_tokens?: number, hidden?: boolean, no_ignore?: boolean }.

Backend resolution (identical output contract for all three):
1. `rg` found on PATH -> use it.
2. Else a pinned ripgrep binary auto-downloaded once to ~/.kinoko/bin. It must fail gracefully and fall through.
3. Else a pure-Bun fallback using Bun.Glob + streaming regex over Bun.file, respecting .gitignore at a basic level.

Content mode: run `rg --json` and parse the stream. Do NOT return raw rg output. Return compact text
grouped by file: path once, then `line: text` per hit, long lines trimmed around the match, optional N
context lines. Rank files by match count, then by recent mtime. Smart-case by default. Respect
.gitignore unless no_ignore.

Token budget: cap by estimated TOKENS (chars/4, default 2000), not by lines. As soon as the budget is
reached, KILL the rg process (early exit). End truncated output with an actionable hint, e.g.
"+142 more matches in 23 files. Narrow with `path`, `glob`, or a more specific pattern."

Files mode: `rg --files -g <glob>` (or the fallback), sorted by mtime, capped by budget with the same hint.
Honor ctx.signal (kill rg on abort) and a hard timeout (10s).
No index, no embeddings, no result caching.

## Acceptance (fixture repo of ~200 files in a temp dir)
Same output shape on the rg backend and the Bun fallback; budget cap respected; early exit is measurably
faster than a full scan on a large match set; abort kills the rg process; .gitignore respected;
truncation hint present. `bun run check` passes.
