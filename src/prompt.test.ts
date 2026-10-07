import { expect, test, describe } from "bun:test";
import { buildSystemPrompt, personaLines } from "./prompt.ts";
import type { ContextFile, SkillEntry } from "./context.ts";
import type { ToolSpec } from "./types.ts";

const INPUT = {
  cwd: "/home/user/project",
  date: "2026-10-07",
  tools: [
    { name: "read", description: "Read a file", schema: {} },
    { name: "bash", description: "Run a command", schema: {} },
  ] as ToolSpec[],
  context: [{ path: "/home/user/project/AGENTS.md", body: "no tabs" }] as ContextFile[],
  skills: [{ path: "/home/user/.agents/skills/om/SKILL.md", name: "om", description: "desktop setup" }] as SkillEntry[],
};

describe("system prompt", () => {
  test("1. fixed text stays inside the ~40 line budget", () => {
    expect(personaLines()).toBeLessThanOrEqual(40);
  });

  test("2. byte-stable: the same input always produces the same bytes", () => {
    expect(buildSystemPrompt(INPUT)).toBe(buildSystemPrompt(INPUT));
    // Two builds an hour apart must not differ by anything but luck: no clock is read here.
    const first = buildSystemPrompt(INPUT);
    const second = buildSystemPrompt({ ...INPUT });
    expect(second).toBe(first);
  });

  test("3. a new day changes exactly one block: the date", () => {
    const today = buildSystemPrompt(INPUT).split("\n\n");
    const tomorrow = buildSystemPrompt({ ...INPUT, date: "2026-10-08" }).split("\n\n");
    expect(tomorrow).toHaveLength(today.length);
    const differing = today.filter((block, i) => block !== tomorrow[i]);
    expect(differing).toHaveLength(1);
    expect(differing[0]).toStartWith("Date: 2026-10-07");
  });

  test("4. carries persona, tools, cwd, context blocks and the skills index", () => {
    const prompt = buildSystemPrompt(INPUT);
    expect(prompt).toStartWith("You are Kinoko");
    expect(prompt).toContain("Tools: read, bash.");
    expect(prompt).toContain("Date: 2026-10-07\nWorking directory: /home/user/project");
    expect(prompt).toContain(`<ctx path="/home/user/project/AGENTS.md">\nno tabs\n</ctx>`);
    expect(prompt).toContain('<skill path="/home/user/.agents/skills/om/SKILL.md" name="om">desktop setup</skill>');
    expect(prompt).toContain("Load a skill body with read");
  });

  test("5. empty discovery adds no empty blocks", () => {
    const bare = buildSystemPrompt({ cwd: "/tmp", date: "2026-10-07", tools: [], context: [], skills: [] });
    expect(bare).toContain("Tools: none.");
    expect(bare).not.toContain("<ctx");
    expect(bare).not.toContain("<skills>");
    // No empty blocks, and the date/cwd block is last.
    expect(bare.split("\n\n").filter((b) => b.trim() === "")).toHaveLength(0);
    expect(bare.split("\n\n").at(-1)).toBe("Date: 2026-10-07\nWorking directory: /tmp");
  });
});