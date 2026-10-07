# Phase 3: core tools (read, write, edit, bash) + output budget

Read first: AGENTS.md, docs/PROGRESS.md, src/types.ts, src/loop.ts.

## Create `src/tools/{read,write,edit,bash,registry,budget,tracker}.ts`
- budget.ts: `budget(output, { maxTokens, id })` estimates tokens as chars/4. If over budget keep
  head + tail, write the FULL output to `.kinoko/spill/<id>.txt`, and append a line telling the model the
  spill path and to use `read` with offset/limit. Never silently drop data.
- tracker.ts: per-session map path -> { mtimeMs, hash } of files the model has read.
- read(path, offset?, limit?): line-numbered output ("   12: text"), default limit 2000 lines,
  refuse binary files, record in the tracker. readOnly: true.
- write(path, content): creates parent dirs. If the file exists it must have been read and be unchanged
  since (tracker); otherwise return an error telling the model to read it first.
- edit(path, edits: [{ old, new }]): same read-before-edit check. Exact UNIQUE substring match.
  Several edits per call, reject overlapping ones, apply all or none. Normalize only Unicode/whitespace
  (NFKC, smart quotes, trailing whitespace) and apply onto the original bytes so untouched lines keep
  their exact whitespace. Errors must distinguish "not found" from "ambiguous (N matches)" and include
  the 3 closest lines as a hint. No line-number editing, ever.
- bash(cmd, timeout?): `node:child_process` spawn("sh", ["-c", cmd], { detached: true }) so it has its own
  process group. Stream stdout/stderr chunks through ctx.onOutput. On ctx.signal abort OR timeout kill
  the whole group with process.kill(-pid, "SIGKILL"). Output goes through budget().
- registry.ts exports defaultTools().

## Acceptance (tests in a temp dir)
Read-before-edit enforced; changed-on-disk detection; ambiguous vs not-found messages; overlap
rejection; spill file created and readable; `sleep 30` aborted via signal: the process is really dead
(process.kill(pid, 0) throws) and the tool returns within 200ms; timeout works. `bun run check` passes.
