// The smallest useful extension: a tool the agent can call, and a slash command for you.
// Copy to ~/.kinoko/ext/hello.ts, then ask the agent "say hello with the hello tool"
// or run: bun run src/main.ts -p "/hello world"

import type { Kinoko } from "../../src/ext.ts";

export default function (k: Kinoko): void {
  k.log("hello loaded");

  k.registerTool({
    name: "hello",
    description: "Greet someone by name. Args: { name: string }.",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: async (args: { name?: unknown }) => {
      const name = typeof args.name === "string" ? args.name : "world";
      return `hello, ${name} (from the hello extension)`;
    },
  });

  k.registerCommand("hello", (args) => `hello, ${args.trim() || "world"}`);
}