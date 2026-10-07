import { resolve } from "node:path";
import { tracker, checkRead, stateOf } from "./tracker";
import type { Tool, ToolContext } from "../types";

async function writeRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || typeof content !== "string") {
    return "ERROR: write: path and content must be strings";
  }
  const abs = resolve(ctx.cwd, path);
  const exists = await Bun.file(abs).exists();
  if (exists) {
    const err = checkRead(abs);
    if (err) return err;
  }
  await Bun.write(abs, content);
  const rec = stateOf(abs, content);
  if (rec) tracker.record(abs, rec);
  return `wrote ${content.length} chars to ${path}`;
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
