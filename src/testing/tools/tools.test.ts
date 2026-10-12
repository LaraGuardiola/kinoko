import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { defaultTools } from "../../tools/registry";
import type { Tool } from "../../types";
import { join } from "node:path";
import { stopHint } from "../../shell.ts";

const ROOT = `${process.cwd()}/.tmp-tools-test-${process.pid}`;

function fresh(name: string): string {
  const dir = `${ROOT}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A core tool; they all answer in text, never with images. */
function pick(name: string): Tool & { run: (args: unknown, ctx: { signal: AbortSignal; cwd: string }) => Promise<string> } {
  const found = defaultTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return { ...found, run: async (args, c) => String(await found.run(args, c)) };
}

function ctx(cwd: string): { signal: AbortSignal; cwd: string } {
  return { signal: new AbortController().signal, cwd };
}

describe("kinoko core tools", () => {
  test("read: line-numbered, offset/limit, binary refusal", async () => {
    const dir = fresh("read");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    const r = pick("read");
    const out = await r.run({ path: "a.txt" }, ctx(dir));
    expect(out).toBe("1: one\n2: two\n3: three");
    const paged = await r.run({ path: "a.txt", offset: 2, limit: 1 }, ctx(dir));
    expect(paged).toBe("2: two\n[lines 2-2 of 3; continue with offset=3]");
    expect(await r.run({ path: "a.txt", offset: 3 }, ctx(dir))).toBe("3: three\n[lines 3-3 of 3]");
    writeFileSync(join(dir, "b.bin"), "a\u0000b");
    const bin = await r.run({ path: "b.bin" }, ctx(dir));
    expect(bin).toContain("ERROR");
  });

  test("read-before-edit enforced", async () => {
    const dir = fresh("rb");
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\n");
    const e = pick("edit");
    const err = await e.run({ path: "a.txt", edits: [{ old: "alpha", new: "x" }] }, ctx(dir));
    expect(err).toContain("must read");
  });

  test("write: creates dirs, read-before-overwrite, changed-on-disk detected", async () => {
    const dir = fresh("w");
    const w = pick("write");
    const r = pick("read");
    const made = await w.run({ path: "sub/deep/new.txt", content: "hello" }, ctx(dir));
    expect(made.includes("ERROR")).toBe(false);
    writeFileSync(join(dir, "other.txt"), "created outside the tracker");
    const unread = await w.run({ path: "other.txt", content: "other" }, ctx(dir));
    expect(unread).toContain("ERROR");
    await r.run({ path: "sub/deep/new.txt" }, ctx(dir));
    writeFileSync(join(dir, "sub/deep/new.txt"), "tampered");
    const stale = await w.run({ path: "sub/deep/new.txt", content: "again" }, ctx(dir));
    expect(stale).toContain("changed on disk");
  });

  test("edit: unique match applies, untouched whitespace kept", async () => {
    const dir = fresh("e1");
    writeFileSync(join(dir, "a.txt"), "keep this\n  indented line  \nkeep this too\n");
    const e = pick("edit");
    const r = pick("read");
    await r.run({ path: "a.txt" }, ctx(dir));
    const ok = await e.run({ path: "a.txt", edits: [{ old: "indented", new: "OUTDATED" }] }, ctx(dir));
    expect(ok.includes("ERROR")).toBe(false);
    const text = readFileSync(join(dir, "a.txt"), "utf8");
    expect(text).toBe("keep this\n  OUTDATED line  \nkeep this too\n");
  });

  test("edit: ambiguous (N matches) vs not found, with line hints", async () => {
    const dir = fresh("amb");
    writeFileSync(join(dir, "a.txt"), "alpha one\nbeta one\ngamma two\n");
    const e = pick("edit");
    const r = pick("read");
    await r.run({ path: "a.txt" }, ctx(dir));
    const amb = await e.run({ path: "a.txt", edits: [{ old: "one", new: "X" }] }, ctx(dir));
    expect(amb).toContain("ambiguous");
    const miss = await e.run({ path: "a.txt", edits: [{ old: "zzz", new: "X" }] }, ctx(dir));
    expect(miss).toContain("not found");
    expect(miss).toContain("Nothing similar");
    const near = await e.run({ path: "a.txt", edits: [{ old: "beta  one\ngamma three", new: "X" }] }, ctx(dir));
    expect(near).toContain("Closest text (lines 2-3):\n2: beta one\n3: gamma two");
  });

  test("edit: overlapping edits rejected, all-or-none", async () => {
    const dir = fresh("ov");
    writeFileSync(join(dir, "a.txt"), "abcdef\n");
    const e = pick("edit");
    const r = pick("read");
    await r.run({ path: "a.txt" }, ctx(dir));
    const bad = await e.run({ path: "a.txt", edits: [{ old: "abc", new: "X" }, { old: "cde", new: "Y" }] }, ctx(dir));
    expect(bad).toContain("overlap");
    const text = readFileSync(join(dir, "a.txt"), "utf8");
    expect(text).toBe("abcdef\n");
    // Separate edits in one call all apply (this used to be rejected as an overlap).
    const ok = await e.run({ path: "a.txt", edits: [{ old: "ef", new: "F" }, { old: "ab", new: "A" }] }, ctx(dir));
    expect(ok).toContain("2 edit(s) applied");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("AcdF\n");
    // The result shows the edited lines as they are on disk now.
    expect(ok).toEndWith("The file now reads:\n1: AcdF\n2: ");
  });

  test("read: a long file is cut at a line boundary with the offset to continue from", async () => {
    const dir = fresh("long");
    writeFileSync(join(dir, "big.txt"), `${"x".repeat(1000)}\n`.repeat(100));
    const out = await pick("read").run({ path: "big.txt" }, ctx(dir));
    expect(out.length).toBeLessThan(42_000);
    expect(out).toMatch(/\[lines 1-\d+ of 100; continue with offset=\d+\]$/);
  });

  test("bash: no stdin, so a command waiting for input ends instead of hanging", async () => {
    const out = await pick("bash").run({ command: "cat; echo done" }, ctx(fresh("stdin")));
    expect(out).toBe("done\n");
  });

  test("bash: output budget spills full output, spill readable", async () => {
    const dir = fresh("spill");
    const b = pick("bash");
    const spillDir = `${process.cwd()}/.kinoko/spill`;
    rmSync(spillDir, { recursive: true, force: true });
    const out = await b.run({ cmd: "seq 1 4000" }, ctx(dir));
    expect(out).toContain("spill");
    const files = readdirSync(spillDir);
    expect(files.length).toBe(1);
    const full = readFileSync(`${process.cwd()}/.kinoko/spill/${files[0]}`, "utf8");
    expect(full).toContain("1\n2");
    expect(out.length).toBeLessThan(4000 * 4 + 200);
  });

  test("bash: a non-zero exit is reported at the end", async () => {
    const b = pick("bash");
    expect(await b.run({ cmd: "echo hi; exit 3" }, ctx(fresh("exit")))).toBe("hi\n\n[exit code 3]");
    expect(await b.run({ cmd: "echo hi" }, ctx(fresh("exit0")))).toBe("hi\n");
  });

  test.skipIf(process.platform === "win32")("bash: a command leaving processes behind (nohup &) says so and how to stop them", async () => {
    const out = await pick("bash").run({ command: "nohup sleep 30 > /dev/null 2>&1 & echo pid=$!" }, ctx(fresh("left")));
    const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
    expect(out).toContain("It left processes running on their own (& or nohup)");
    expect(out).toMatch(/To stop them: kill -- -\d+/);
    process.kill(pid, "SIGKILL");
    expect(await pick("bash").run({ command: "echo hi" }, ctx(fresh("left2")))).toBe("hi\n");
  });

  test("bash: abort kills the process group, returns <200ms", async () => {
    const dir = fresh("abort");
    const b = pick("bash");
    const controller = new AbortController();
    const started = Date.now();
    const run = b.run({ cmd: "echo $$ > pid.txt && sleep 30" }, { signal: controller.signal, cwd: dir });
    setTimeout(() => controller.abort(), 50);
    const out = await run;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(out).toBe("Aborted by user");
    await Bun.sleep(100);
    const pid = parseInt(readFileSync(join(dir, "pid.txt"), "utf8"), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    // Git Bash's $$ is an MSYS pid, not a Windows one: there the time taken is the proof.
    if (process.platform !== "win32") expect(alive).toBe(false);
  });

  test("bash: timeout kills the group", async () => {
    const dir = fresh("to");
    const b = pick("bash");
    const t0 = Date.now();
    const out = await b.run({ cmd: "echo $$ > pid.txt && sleep 5", timeout: 150 }, ctx(dir));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).toContain("timed out");
    const pid = parseInt(readFileSync(join(dir, "pid.txt"), "utf8"), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    // Git Bash's $$ is an MSYS pid, not a Windows one: there the time taken is the proof.
    if (process.platform !== "win32") expect(alive).toBe(false);
  });
});

// afterAll, not a test: a failing run must still take its fixtures with it.
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bash background: true", () => {
  test("starts a job through the context and returns at once, saying not to wait; without jobs, an error", async () => {
    const started: string[] = [];
    const background = (command: string): { id: number; pid: number; log: string } => (started.push(command), { id: 4, pid: 4242, log: "/l/4.log" });
    const out = await pick("bash").run({ command: "make -j8", background: true }, { ...ctx(fresh("bg")), background } as never);
    expect(started).toEqual(["make -j8"]);
    expect(out).toStartWith("started background job #4 (pid 4242): make -j8\nDo not wait for it");
    expect(out).toContain(stopHint(4242)); // kill -- -4242; taskkill on Windows
    expect(await pick("bash").run({ command: "make", background: true }, ctx(fresh("bg2")))).toStartWith("ERROR: bash: background jobs only run");
  });
});
