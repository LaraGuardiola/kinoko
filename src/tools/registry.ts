import { readTool } from "./read";
import { writeTool } from "./write";
import { editTool } from "./edit";
import { bashTool } from "./bash";
import { searchTool } from "./search";
import { todoTool } from "./todo";
import type { Tool } from "../types";

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, searchTool, todoTool];
}
