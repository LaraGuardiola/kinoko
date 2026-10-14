import { describe, expect, test } from "bun:test";
import { FLOOR, MACHINE_IDS, PHONE_FLOOR, beltPoints, routePoints } from "../../../serve/lab/machines.ts";
import type { Blueprint } from "../../../serve/lab/machines.ts";
import { MACHINE_WORDS } from "../../../serve/lab/words.ts";

const pairs = (plan: Blueprint): string[] => plan.belts.map((b) => `${b.from}>${b.to}`).toSorted();

/** Every belt runs straight between its corners: each step changes x or y, never both. */
function crooked(plan: Blueprint): string[] {
  return plan.belts.filter((b) => beltPoints(plan, b).some((p, i, all) => i > 0 && p[0] !== all[i - 1]![0] && p[1] !== all[i - 1]![1])).map((b) => `${b.from}>${b.to}`);
}

describe("Kinoko Lab: the floor", () => {
  test("every machine has a cell of its own on both floors, inside it, and words", () => {
    for (const plan of [FLOOR, PHONE_FLOOR]) {
      const cells = MACHINE_IDS.map((id) => plan.at[id].join(","));
      expect(new Set(cells).size).toBe(MACHINE_IDS.length);
      for (const id of MACHINE_IDS) {
        const [c, r] = plan.at[id];
        expect(c >= 0 && c < plan.cols && r >= 0 && r < plan.rows).toBe(true);
        expect(MACHINE_WORDS[id].name.length).toBeGreaterThan(0);
      }
    }
  });

  test("belts run straight on both floors, and the same belts are laid on each (any route works on either)", () => {
    expect(crooked(FLOOR)).toEqual([]);
    expect(crooked(PHONE_FLOOR)).toEqual([]);
    expect(pairs(PHONE_FLOOR)).toEqual(pairs(FLOOR));
  });

  test("a route rides belt after belt, without repeating the machine between them", () => {
    expect(routePoints(FLOOR, ["history", "context", "request"])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(routePoints(FLOOR, ["approval", "gate", "history"])).toEqual([[4, 3], [4.1, 3], [4.1, 2], [4, 2], [4, 1.5], [0.3, 1.5], [0.3, 1], [0, 1]]);
  });
});

describe("Kinoko Lab: the signs", () => {
  test("every machine has an 8 × 7 pixel sign", async () => {
    const { ICONS } = await import("../../../serve/lab/page/icons.ts");
    for (const id of MACHINE_IDS) expect(ICONS[id].map((row) => row.length)).toEqual([8, 8, 8, 8, 8, 8, 8]);
  });
});
