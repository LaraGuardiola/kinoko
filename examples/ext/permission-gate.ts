// Blocks dangerous shell commands. Copy to ~/.kinoko/ext/ or ./.kinoko/ext/ to enable.
//
// Two layers:
//   1. a HARDLINE that nothing can switch off (wiping a filesystem or a home directory)
//   2. a confirm/deny gate for the rest, opened with KINOKO_YOLO=1
//
// The yolo flag deliberately does NOT reach the hardline: there is no way to make this file allow
// `rm -rf /`, on purpose.

import type { Kinoko, ToolCallBlock } from "../../src/ext.ts";

const HARDLINE =
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\/\*|\/\.\*|\.\s*$|\/\s*$)|mkfs(\.\w+)?\s|:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:|>\s*\/dev\/sd[a-z]/i;

const GATED: Array<[string, RegExp]> = [
  ["rm -rf", /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i],
  ["sudo", /(^|[\s;&|])sudo\s/i],
  ["chmod 777", /\bchmod\s+(-[a-z]+\s+)*777\b/i],
  ["dd", /\bdd\s+if=/i],
  ["shutdown/reboot", /\b(shutdown|reboot|halt|poweroff)\b/i],
];

const yolo = process.env.KINOKO_YOLO === "1";

export default function (k: Kinoko): void {
  k.log(`permission-gate loaded (${yolo ? "yolo: gated commands allowed" : "confirm mode"})`);

  k.on("tool_call", (call) => {
    if (call.name !== "bash") return;
    const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
    if (cmd === "") return;

    if (HARDLINE.test(cmd)) {
      return block(cmd, "hardline: this command is never allowed, not even with KINOKO_YOLO=1");
    }
    for (const [label, re] of GATED) {
      if (!re.test(cmd)) continue;
      if (yolo) return;
      return block(
        cmd,
        `denied by permission-gate: \`${label}\` needs confirmation. Narrow the command, or run it yourself outside Kinoko. (KINOKO_YOLO=1 allows gated commands; the hardline stays blocked)`,
      );
    }
  });
}

function block(_cmd: string, reason: string): ToolCallBlock {
  return { block: true, reason: reason };
}