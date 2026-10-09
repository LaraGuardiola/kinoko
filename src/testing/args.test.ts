import { describe, expect, test } from "bun:test";
import { parseArgs } from "../args.ts";

describe("command line", () => {
  test("-c and --continue resume the newest session; -c is never taken as the prompt", () => {
    expect(parseArgs(["-c"])).toMatchObject({ resume: true, prompt: undefined, mode: "tui" });
    expect(parseArgs(["--continue"])).toMatchObject({ resume: true });
    expect(parseArgs(["-c", "--mode", "rpc"])).toMatchObject({ resume: true, mode: "rpc", explicitMode: true });
    expect(parseArgs(["-c", "-p", "hi"])).toMatchObject({ resume: true, prompt: "hi", mode: "print" });
  });

  test("--session, config flags in both spellings, a bare prompt", () => {
    expect(parseArgs(["--session", "7c7b"]).session).toBe("7c7b");
    expect(parseArgs(["--base-url", "http://x/v1", "--apiKey", "k"]).flags).toEqual({ baseUrl: "http://x/v1", apiKey: "k" });
    expect(parseArgs(["fix the bug"])).toMatchObject({ prompt: "fix the bug", resume: false, mode: "tui" });
  });
});
