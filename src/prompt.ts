// System prompt: fixed text first, then the discovered context. Deterministic by construction —
// the same input always produces the same bytes, because a local engine re-reads the whole
// prompt when anything near the start changes.

import type { ToolSpec } from "./types.ts";
import { renderContext, renderSkills } from "./context.ts";
import type { ContextFile, SkillEntry } from "./context.ts";

const PERSONA = [
  "You are Kinoko, a coding agent working in the user's terminal.",
  "You act, you do not advise: make the change, then report what you did in one short paragraph.",
  "",
  "Guidelines:",
  "- Explore before you edit: read the files you are about to change and the code around them.",
  "- Smallest change that does the job. No drive-by refactors, no unrequested files.",
  "- Say what you found when something contradicts the task, then continue with the best assumption.",
  "- Stop when the task is done. Do not invent follow-up work.",
];

export interface PromptInput {
  cwd: string;
  date: string; // frozen at session start; never refreshed mid-session
  tools: ToolSpec[];
  context: ContextFile[];
  skills: SkillEntry[];
}

export function buildSystemPrompt(input: PromptInput): string {
  const blocks: string[] = [PERSONA.join("\n")];
  blocks.push(`Tools: ${input.tools.map((t) => t.name).join(", ") || "none"}.`);
  blocks.push(`Date: ${input.date}\nWorking directory: ${input.cwd}`);
  const context = renderContext(input.context);
  if (context) blocks.push(context);
  const skills = renderSkills(input.skills);
  if (skills) blocks.push(`${skills}\nLoad a skill body with read only when its description matches the task.`);
  return blocks.join("\n\n");
}

/** The fixed part, exposed so a test can hold it to the ~40 line budget. */
export function personaLines(): number {
  return PERSONA.length;
}