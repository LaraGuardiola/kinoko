# Phase 5: session persistence, context discovery, compaction

Read first: AGENTS.md, docs/PROGRESS.md, docs/interruption.md, src/loop.ts.

## Create
- `src/session.ts`: append-only JSONL at ~/.kinoko/sessions/<project-hash>/<id>.jsonl. Every message has
  id + parentId; keep a `head` pointer so a future /fork is just moving the head.
  Functions: create, append, load (resume), activeBranch(). The Agent appends every message as it is
  finalized, including aborted ones and synthetic "Aborted by user" results.
  `--continue` flag resumes the latest session.
- `src/context.ts`: walk from cwd up to the filesystem root collecting AGENTS.md (fallback CLAUDE.md in the
  same dir), emit ROOT-FIRST wrapped as <ctx path="...">...</ctx>. Also scan ./.agents/skills/*/SKILL.md
  and ~/.agents/skills/*/SKILL.md: parse YAML frontmatter (name, description only) and emit an XML
  index. The model loads skill bodies with the normal `read` tool; do NOT add a skill tool.
- `src/prompt.ts`: builds the system prompt (persona, tool list, 3-5 short guidelines, context blocks,
  skills index, date, cwd). Max ~40 lines of fixed text. Byte-stable between turns (no timestamps
  except the date).
- `src/compact.ts`: trigger when estimated tokens > contextWindow - 16384, OR reactively when the
  provider returns a context-overflow error. Keep a verbatim tail (~20k tokens) and summarize the rest
  with the same model. If a previous summary exists, pass it in and MERGE it (keep still-true details,
  drop stale ones). Sections: Objective / Decisions / Work State / Next Step / Relevant Files.
  It uses the run's abort signal: aborting during compaction leaves history unchanged.

## Cache-friendly history (local engines re-read the whole prompt if the prefix changes)
Engines like Strata reuse the prompt prefix between requests; a change near the start forces a full
re-read (about 1 minute per 30k tokens). Therefore:
1. History is APPEND-ONLY between compactions: never edit, truncate or prune old messages.
2. System prompt and tool schemas are byte-stable for the whole session. AGENTS.md and skills are read
   once at session start. The date is frozen at session start (do not update it at midnight).
3. Replaying a message must produce the same bytes every turn: serialize tool-call arguments with one
   deterministic function and never re-order keys.
4. Steer and follow-up messages are only ever appended at the end.
5. Compaction is the one allowed prefix change. Keep its trigger late, keep the summary compact, and show
   "compacted: full prompt re-read expected" in the status line later (Phase 9).
6. The compaction summary request goes through the same sequential provider: never in parallel.

## Acceptance
Resume restores state; a resumed aborted run has valid tool/result pairing; context discovery order test
with nested dirs; compaction keeps the tail, merges the previous summary, and abort-during-compaction is
a no-op. `bun run check` passes.
Also: replaying the same history twice produces byte-identical request bodies (test it).
