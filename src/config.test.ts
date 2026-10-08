import { expect, test } from "bun:test";
import { thinkingLabel } from "./config.ts";

test("the thinking label: level, budget when one is set, OFF without one", () => {
  expect(thinkingLabel("low", 2048)).toBe("LOW · 2048");
  expect(thinkingLabel("high", undefined)).toBe("HIGH");
  expect(thinkingLabel(undefined, undefined)).toBe("DEFAULT");
  expect(thinkingLabel("off", 2048)).toBe("OFF");
});
