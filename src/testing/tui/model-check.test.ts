import { describe, expect, test } from "bun:test";
import { mismatchNote } from "../../tui/model-check.ts";

describe("model check", () => {
  test("a model its endpoint serves, or an endpoint that does not say: nothing to tell", () => {
    expect(mismatchNote("minicpm", ["minicpm"], "127.0.0.1:8085")).toBeUndefined();
    expect(mismatchNote("minicpm", [], "127.0.0.1:8085")).toBeUndefined();
  });

  test("another one: says what it serves, by name, and how to make it the default", () => {
    expect(mismatchNote("/home/u/Downloads/Qwen3.6-Q4_K_M.gguf", ["MiniCPM-V-4.7"], "127.0.0.1:8085")).toBe(
      "Qwen3.6-Q4_K_M is not what 127.0.0.1:8085 serves: it serves MiniCPM-V-4.7. In /models, D on the right one makes it the default.",
    );
    expect(mismatchNote("x", ["a", "b", "c", "d", "e"], "api")).toBe("x is not what api serves: it serves a, b, c and 2 more. In /models, D on the right one makes it the default.");
  });
});
