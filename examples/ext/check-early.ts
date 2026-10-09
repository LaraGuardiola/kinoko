// Asks the model to check its work early. Copy to ~/.kinoko/ext/ or ./.kinoko/ext/ to enable.
//
// A model writing a project file by file tends to write all of it first and compile at the end,
// then spends dozens of turns (each re-sending a full context) fixing errors one by one. After
// EVERY source files written or edited with no check in between, this appends a note to the tool
// result: run the build, typecheck, lint or tests now. A bash command that looks like one of those
// starts the count again.

import type { Kinoko } from "../../src/ext.ts";

export const EVERY = 4;

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|zig|lua)$/i;

const CHECK =
  /\b(tsc|typecheck|check|lint|oxlint|eslint|biome|test|tests|build|vitest|jest|pytest|mypy|ruff|clippy|vet|make|gradle|mvn|ctest)\b/;

export const NOTE = (n: number): string =>
  `\n\n[check-early] ${n} source files changed since the last check. Run the project's check now ` +
  "(build, typecheck, lint or tests) and fix what it reports before writing more: errors are cheapest while they are few.";

export default function (k: Kinoko): void {
  let changed = new Set<string>();
  let path = ""; // the source file the running write/edit acts on
  let command = ""; // the running bash command

  k.on("session_start", () => {
    changed = new Set();
  });

  k.on("tool_call", (call) => {
    path = "";
    command = "";
    if (call.name === "write" || call.name === "edit") {
      const p = call.args.path;
      if (typeof p === "string" && SOURCE.test(p)) path = p;
    } else if (call.name === "bash") {
      const c = call.args.command ?? call.args.cmd;
      if (typeof c === "string") command = c;
    }
  });

  k.on("tool_result", (result) => {
    if (result.name === "bash") {
      if (CHECK.test(command)) changed = new Set();
      return;
    }
    if (path === "" || result.output.startsWith("ERROR")) return;
    changed.add(path);
    if (changed.size < EVERY) return;
    result.output += NOTE(changed.size);
    changed = new Set();
  });
}
