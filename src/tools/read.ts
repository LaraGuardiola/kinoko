import { resolve } from "node:path";
import { tracker, stateOf } from "./tracker";
import type { Tool, ToolContext } from "../types";

const DEFAULT_LIMIT = 2000;

function numberArg(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : fallback;
}

function fileIsBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

function splitLines(text: string): string[] {
  if (text.endsWith("\n")) return text.slice(0, -1).split("\n");
  return text.split("\n");
}

async function readRun(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = args.path;
  if (typeof path !== "string") return "ERROR: read: path must be a string";
  const abs = resolve(ctx.cwd, path);
  const file = Bun.file(abs);
  if (!await file.exists()) return `ERROR: file not found: ${path}`;
  const text = await file.text();
  if (fileIsBinary(text)) return `ERROR: read refused: ${path} looks binary`;
  const lines = splitLines(text);
  const offset = numberArg(args.offset, 1);
  const limit = numberArg(args.limit, DEFAULT_LIMIT);
  if (offset > lines.length) return `read: offset ${offset} is past end of file (${lines.length} lines)`;
  const last = Math.min(lines.length, offset + limit - 1);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = offset; n <= last; n++) {
    out.push(`${String(n).padStart(width)}: ${lines[n - 1]}`);
  }
  const rec = stateOf(abs, text);
  if (rec) tracker.record(abs, rec);
  return out.join("\n");
}

export const readTool: Tool = {
  name: "read",
  description: "Read a text file, returning line-numbered lines (\"  12: text\"). offset = 1-based first line, limit = max lines (default 2000). Binary files are refused.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number", description: "1-based first line (default 1)" },
      limit: { type: "number", description: "max lines (default 2000)" },
    },
    required: ["path"],
  },
  readOnly: true,
  run: readRun,
};
