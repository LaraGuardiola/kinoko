import { readTool } from "./read";
import { writeTool } from "./write";
import { editTool } from "./edit";
import { bashTool } from "./bash";
import type { Tool } from "../types";

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool];
}
