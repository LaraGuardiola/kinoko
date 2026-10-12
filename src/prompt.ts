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
  "- Independent calls go in one reply (several files to write or read): one at a time only when the next needs this one's result.",
  "- Smallest change that does the job. No drive-by refactors, no unrequested files.",
  "- Say what you found when something contradicts the task, then continue with the best assumption.",
  "- Files change only through your tools or the user. If a file is not what you remember, your memory is wrong: trust the tool result.",
  "- Stop when the task is done. Do not invent follow-up work.",
];

export interface PromptInput {
  cwd: string;
  model: string; // the id as the engine knows it; shown as modelName()
  date: string; // frozen at session start; never refreshed mid-session
  tools: ToolSpec[];
  context: ContextFile[];
  skills: SkillEntry[];
  /** The OS and the shell the bash tool runs ("Windows; bash tool: PowerShell ..."): what commands work. */
  system?: string;
}

export function buildSystemPrompt(input: PromptInput): string {
  const blocks: string[] = [PERSONA.join("\n")];
  blocks.push(`Tools: ${input.tools.map((t) => t.name).join(", ") || "none"}.`);
  // Without it a model asked what it is guesses, then goes looking (ps, config files) and confabulates.
  blocks.push(`Date: ${input.date}\nModel: ${modelName(input.model)} (Kinoko is the harness, this is the model)\nWorking directory: ${input.cwd}${input.system ? `\nSystem: ${input.system}` : ""}`);
  const context = renderContext(input.context);
  if (context) blocks.push(context);
  const skills = renderSkills(input.skills);
  if (skills) blocks.push(`${skills}\nLoad a skill body with read only when its description matches the task.`);
  return blocks.join("\n\n");
}

/**
 * A model id as people read it: llama.cpp names a model by its file path, so the directory, the
 * file type and a shard suffix go ("/models/Qwen3.6-35B-Q4_K_M-00001-of-00002.gguf" -> "Qwen3.6-35B-Q4_K_M").
 */
export function modelName(id: string): string {
  const file = id.split(/[/\\]/).at(-1) || id;
  return file.replace(/\.(gguf|safetensors|bin|pt|onnx)$/i, "").replace(/-\d{5}-of-\d{5}$/, "");
}

/** The fixed part, exposed so a test can hold it to the ~40 line budget. */
export function personaLines(): number {
  return PERSONA.length;
}