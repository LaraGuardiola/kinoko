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

## Acceptance
Resume restores state; a resumed aborted run has valid tool/result pairing; context discovery order test
with nested dirs; compaction keeps the tail, merges the previous summary, and abort-during-compaction is
a no-op. `bun run check` passes.
