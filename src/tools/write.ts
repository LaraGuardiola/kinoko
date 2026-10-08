import { resolve } from "node:path";
import { checkRead, remember } from "./tracker";
import type { Tool, ToolContext } from "../types";

async function writeRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string") return "ERROR: write: missing path (string)";
  if (typeof content !== "string") return "ERROR: write: missing content (string)";
  const abs = resolve(ctx.cwd, path);
  if (await Bun.file(abs).exists()) {
    const err = await checkRead(abs);
    if (err) return err;
  }
  await Bun.write(abs, content);
  await remember(abs, content);
  const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return `wrote ${lines} lines (${content.length} chars) to ${path}`;
}

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file with the given content (parent dirs are created). An existing file must have been read and be unchanged since.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  run: writeRun,
};
