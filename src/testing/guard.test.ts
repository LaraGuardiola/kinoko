import { describe, expect, test } from "bun:test";
import { CallGuard, REPEAT_LINES, REPEAT_RUN, RepeatGuard } from "../guard.ts";

describe("RepeatGuard", () => {
  test("trips when one long line repeats REPEAT_LINES times, across chunk boundaries", () => {
    const guard = new RepeatGuard();
    const line = "Writing chunk manager code for the mesher...\n";
    let tripped = false;
    for (let i = 0; i < REPEAT_LINES; i++) {
      // Split mid-line: lines are only counted once complete.
      tripped = guard.push(line.slice(0, 10)) || guard.push(line.slice(10)) || tripped;
    }
    expect(tripped).toBe(true);
  });

  test("a short line repeated REPEAT_RUN times in a row trips", () => {
    const guard = new RepeatGuard();
    let tripped = false;
    for (let i = 0; i < REPEAT_RUN; i++) tripped = guard.push('    "strict": true,\n') || tripped;
    expect(tripped).toBe(true);
  });

  test("short lines and varied text never trip", () => {
    const guard = new RepeatGuard();
    let tripped = false;
    for (let i = 0; i < 50; i++) tripped = guard.push("}\n```\n") || guard.push(`step ${i}: checking the next file now\n`) || tripped;
    expect(tripped).toBe(false);
  });
});

describe("CallGuard", () => {
  test("the same error from calls with different arguments is counted; a success resets it", () => {
    const guard = new CallGuard();
    const err = 'error: Could not resolve: "../config/test.ts"';
    expect(guard.failures({ id: "1", name: "bash", args: { command: "bun build a" } }, err)).toBe(1);
    expect(guard.failures({ id: "2", name: "bash", args: { command: "bun build a --root src" } }, err)).toBe(2);
    expect(guard.failures({ id: "3", name: "bash", args: { command: "ls" } }, "src")).toBe(0);
    expect(guard.failures({ id: "4", name: "bash", args: { command: "bun build b" } }, err)).toBe(1);
    // Repeated empty or successful outputs are never a failure streak.
    expect(guard.failures({ id: "5", name: "bash", args: { command: "mkdir x" } }, "")).toBe(0);
  });

  test("counts the same call with the same result; a new result resets the count", () => {
    const guard = new CallGuard();
    const call = { id: "1", name: "bash", args: { cmd: "bun test" } };
    expect(guard.record(call, "fail")).toBe(1);
    expect(guard.record({ ...call, id: "2" }, "fail")).toBe(2);
    expect(guard.record(call, "pass")).toBe(1);
    expect(guard.record({ ...call, args: { cmd: "ls" } }, "pass")).toBe(1);
  });
});
