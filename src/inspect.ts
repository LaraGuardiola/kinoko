// A request as a person can look at it: its size at a glance, and the request itself as plain JSON
// (no signal, no tool code, no image bytes). Kinoko Lab shows these when a machine is clicked.

import { contextTokens, historyTokens } from "./compact.ts";
import { estimateTokens } from "./tools/budget.ts";
import type { RequestSize } from "./agent-events.ts";
import type { Image, Message, ProviderRequest, Tool, ToolSpec } from "./types.ts";

export type Inspectable = "request" | "system" | "tools";

export function requestSize(req: ProviderRequest): RequestSize {
  const schemas = JSON.stringify(toolSpecs(req.tools));
  const history = req.messages.reduce((sum, m) => sum + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);
  // A reply's usage already counts the system prompt and the schemas it was sent with.
  const counted = req.messages.some((m) => m.usage !== undefined);
  const tokens = counted ? contextTokens(req.messages) : historyTokens(req.messages) + estimateTokens(req.system + schemas);
  return { messages: req.messages.length, tools: req.tools.length, chars: req.system.length + schemas.length + history, tokens };
}

/** The tools as the model gets them: what each is for and its arguments, not its code. */
export function toolSpecs(tools: ToolSpec[] | Tool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}

/** A message without its pictures' bytes: their type and size stay. */
export function withoutImageBytes(m: Message): Message & { images?: Array<Image & { size?: number }> } {
  return m.images ? { ...m, images: m.images.map((i) => ({ mime: i.mime, data: "", size: Math.round(i.data.length * 0.75) })) } : m;
}

/** The request as it left: model, thinking settings, system prompt, tools and history. */
export function requestJson(req: ProviderRequest): object {
  return {
    model: req.model,
    ...(req.effort !== undefined ? { effort: req.effort } : {}),
    ...(req.budget !== undefined ? { budget: req.budget } : {}),
    system: req.system,
    tools: toolSpecs(req.tools),
    messages: req.messages.map(withoutImageBytes),
  };
}
