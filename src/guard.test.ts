import { describe, expect, test } from "bun:test";
import { CallGuard, REPEAT_LINES, REPEAT_RUN, RepeatGuard } from "./guard.ts";

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
  test("counts the same call with the same result; a new result resets the count", () => {
    const guard = new CallGuard();
    const call = { id: "1", name: "bash", args: { cmd: "bun test" } };
    expect(guard.record(call, "fail")).toBe(1);
    expect(guard.record({ ...call, id: "2" }, "fail")).toBe(2);
    expect(guard.record(call, "pass")).toBe(1);
    expect(guard.record({ ...call, args: { cmd: "ls" } }, "pass")).toBe(1);
  });
});
