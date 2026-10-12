import { resolve } from "node:path";
import { isCrlf, withEndings } from "./eol";
import { checkRead, remember } from "./tracker";
import type { Tool, ToolContext } from "../types";

async function writeRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string") return "ERROR: write: missing path (string)";
  if (typeof content !== "string") return "ERROR: write: missing content (string)";
  const abs = resolve(ctx.cwd, path);
  let text = content;
  if (await Bun.file(abs).exists()) {
    const before = await Bun.file(abs).text();
    const err = await checkRead(abs, before);
    if (err) return err;
    text = withEndings(content, isCrlf(before)); // a CRLF file (Windows) stays CRLF
  }
  await Bun.write(abs, text);
  await remember(abs, text);
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
