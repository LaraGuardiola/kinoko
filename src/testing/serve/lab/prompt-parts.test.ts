import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../../../prompt.ts";
import { promptParts } from "../../../serve/lab/prompt-parts.ts";

const base = { cwd: "/p", model: "m", date: "2026-10-14", tools: [{ name: "read", description: "", schema: {} }] };

describe("Kinoko Lab: the system prompt in parts", () => {
  test("the real prompt: persona, tools, where and when, each context file (blank lines and all), skills; joined back it is the prompt", () => {
    const system = buildSystemPrompt({
      ...base,
      context: [
        { path: "/p/AGENTS.md", body: "# Rules\n\nOne.\n\nTwo." },
        { path: "/p/sub/AGENTS.md", body: "More." },
      ],
      skills: [{ name: "pdf", path: "/s/pdf/SKILL.md", description: "PDFs" }],
    });
    const parts = promptParts(system);
    expect(parts.map((p) => p.label)).toEqual([
      "Who the model is told it is",
      "The tools, by name",
      "Where and when",
      "Context: /p/AGENTS.md",
      "Context: /p/sub/AGENTS.md",
      "Skills (their names and descriptions only)",
    ]);
    expect(parts.map((p) => p.text).join("")).toBe(system);
    expect(parts[3]?.text).toContain("One.\n\nTwo.");
  });

  test("no context, no skills; or a prompt it does not know: still the whole text", () => {
    const system = buildSystemPrompt({ ...base, context: [], skills: [] });
    expect(promptParts(system).map((p) => p.label)).toEqual(["Who the model is told it is", "The tools, by name", "Where and when"]);
    expect(promptParts("be brief")).toEqual([{ label: "Who the model is told it is", text: "be brief" }]);
  });
});
