// Plan mode: the agent may look, but not touch. Blocks write and edit, and any bash command that is
// not plainly read-only. Copy to ./.kinoko/ext/ to switch it on; delete the file to switch it off.

import type { Kinoko } from "../../src/ext.ts";

const READ_ONLY = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "which",
  "whoami",
  "date",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "find",
  "grep",
  "rg",
  "sed -n",
  "awk",
  "jq",
  "sort",
  "uniq",
  "diff",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "bun -e",
];

const BLOCKED_TOOLS: Record<string, string> = {
  write: "plan mode is read-only: propose the content instead of writing it",
  edit: "plan mode is read-only: propose the change instead of applying it",
};

export default function (k: Kinoko): void {
  k.log("plan-mode loaded: write and edit are blocked");

  k.on("tool_call", (call) => {
    const reason = BLOCKED_TOOLS[call.name];
    if (reason !== undefined) return { block: true, reason: reason };
    if (call.name !== "bash") return;
    const cmd = typeof call.args.cmd === "string" ? call.args.cmd.trim() : "";
    if (cmd === "") return;
    if (isReadOnly(cmd)) return;
    return {
      block: true,
      reason: `plan mode: \`${firstLine(cmd)}\` mutates state. Read-only commands are: ${READ_ONLY.join(", ")}. Run it yourself when you are ready.`,
    };
  });
}

/**
 * Every segment of every line must be read-only, so `ls && rm x` cannot slip through on its first
 * word. Quoted separators would need a real shell parser; that is out of scope for an example.
 */
function isReadOnly(cmd: string): boolean {
  return segments(cmd).every((part) => {
    if (part === "" || part.startsWith("#")) return true;
    // A read command that writes (redirection, tee) is not read-only.
    if (part.includes(">") || part.startsWith("tee")) return false;
    return READ_ONLY.some((allowed) => part === allowed || part.startsWith(`${allowed} `));
  });
}

function segments(cmd: string): string[] {
  return cmd
    .split("&&")
    .flatMap((a) => a.split("||"))
    .flatMap((a) => a.split(";"))
    .flatMap((a) => a.split("\n"))
    .flatMap((a) => a.split("|"))
    .map((part) => part.trim());
}

function firstLine(cmd: string): string {
  const line = cmd.split("\n")[0] ?? cmd;
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}