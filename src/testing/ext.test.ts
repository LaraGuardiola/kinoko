import { expect, test, describe, afterAll } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Extensions, extensionName, loadExtensions, loadOne } from "../ext.ts";
import { Agent } from "../loop.ts";
import type { AgentEvent } from "../loop.ts";
import type { Message, Provider, StreamEvent, Tool } from "../types.ts";

const ROOT = `${process.cwd()}/.tmp-ext-test-${process.pid}`;
const EXAMPLES = `${process.cwd()}/examples/ext`;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A collector so tests can assert on what extensions logged. */
function extBus(): { ext: Extensions; log: string[] } {
  const log: string[] = [];
  return { ext: new Extensions((line) => log.push(line)), log };
}

/** Writes an extension source file and returns its path. */
function writeExt(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

/** Writes a module that appends its name to a JSON file, so load order is observable on disk. */
function writeOrderProbe(dir: string, name: string, tag: string): string {
  return writeExt(
    dir,
    name,
    `import { appendFileSync } from "node:fs";
export default function (): void {
  appendFileSync(${JSON.stringify(join(dir, "order.log"))}, ${JSON.stringify(`${tag}:${name}\n`)});
}
`,
  );
}

describe("extension loader", () => {
  test("1. load order: user dir first, then project dir, name-sorted inside each", async () => {
    const home = `${ROOT}/order-home`;
    const cwd = `${ROOT}/order-project`;
    rmSync(`${ROOT}/order-home`, { recursive: true, force: true });
    writeOrderProbe(`${home}/.kinoko/ext`, "z-second.ts", "user");
    writeOrderProbe(`${home}/.kinoko/ext`, "a-first.ts", "user");
    writeOrderProbe(`${cwd}/.kinoko/ext`, "m-project.ts", "project");
    writeFileSync(`${cwd}/.kinoko/ext/notes.md`, "not an extension");

    const { ext } = extBus();
    const loaded = await loadExtensions(ext, { cwd: cwd, home: home });
    expect(loaded.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual([
      "a-first.ts",
      "z-second.ts",
      "m-project.ts",
    ]);
    const log = (await Bun.file(`${home}/.kinoko/ext/order.log`).text()).trim().split("\n");
    expect(log).toEqual(["user:a-first.ts", "user:z-second.ts"]);
  });

  test("1a. a folder with an index.ts is an extension, in name order with the files; its name is the folder's", async () => {
    const home = `${ROOT}/folder-home`;
    rmSync(home, { recursive: true, force: true });
    writeOrderProbe(`${home}/.kinoko/ext`, "b-file.ts", "user");
    mkdirSync(`${home}/.kinoko/ext/a-folder`, { recursive: true });
    writeFileSync(`${home}/.kinoko/ext/a-folder/index.ts`, "export default function (k) { k.registerCommand('folder', () => 'from a folder'); }\n");
    mkdirSync(`${home}/.kinoko/ext/no-index`, { recursive: true }); // a folder without index.ts is skipped
    const { ext } = extBus();
    const loaded = await loadExtensions(ext, { cwd: home, home: home });
    expect(loaded.map(extensionName)).toEqual(["a-folder", "b-file"]);
    expect(await ext.command("folder")?.("")).toBe("from a folder");
  });

  test("1c. live: an extension loaded late starts like the others, reloads from its updated file, unloads cleanly", async () => {
    const dir = `${ROOT}/live/a-live`;
    rmSync(`${ROOT}/live`, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const version = (v: string): void =>
      writeFileSync(
        `${dir}/index.ts`,
        `export default function (k) {
  k.on("session_start", (info) => k.registerCommand("mode", () => info.mode + " ${v}"));
  k.registerTool({ name: "tool_${v}", description: "", schema: {}, run: async () => "" });
  k.on("tool_result", (r) => { r.output += " [${v}]"; });
}\n`,
      );
    const { ext } = extBus();
    ext.on("tool_result", (r) => {
      r.output += " [core]";
    }); // someone else's handler: never taken back
    ext.emit("session_start", { cwd: "/p", model: "m", mode: "tui" }); // the session started before it
    version("v1");
    expect(await loadOne(ext, `${dir}/index.ts`)).toBeUndefined();
    expect(await ext.command("mode")?.("")).toBe("tui v1"); // session_start replayed to it alone
    version("v2");
    expect(await loadOne(ext, `${dir}/index.ts`)).toBeUndefined();
    expect(ext.tools().map((t) => t.name)).toEqual(["tool_v2"]); // the old copy is gone
    const result = { name: "read", output: "x", signal: new AbortController().signal };
    ext.emit("tool_result", result);
    expect(result.output).toBe("x [core] [v2]");
    expect(ext.unload("a-live")).toBe(true);
    expect(ext.tools()).toEqual([]);
    expect(ext.command("mode")).toBeUndefined();
    expect(ext.unload("a-live")).toBe(false);
    writeFileSync(`${dir}/index.ts`, "export default 1;\n");
    expect(await loadOne(ext, `${dir}/index.ts`)).toBe("a-live did not load (see the log)");
  });

  test("1b. run from $HOME, the shared ext dir is loaded once", async () => {
    const home = `${ROOT}/same-home`;
    rmSync(home, { recursive: true, force: true });
    writeOrderProbe(`${home}/.kinoko/ext`, "web.ts", "user");
    const { ext } = extBus();
    const loaded = await loadExtensions(ext, { cwd: home, home: home });
    expect(loaded.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual(["web.ts"]);
  });

  test("2. a broken extension is skipped, the good ones still load", async () => {
    const home = `${ROOT}/broken-home`;
    const cwd = `${ROOT}/broken-project`;
    const { ext, log } = extBus();
    writeExt(`${home}/.kinoko/ext`, "1-syntax.ts", "export default function ( { this is not typescript");
    writeExt(`${home}/.kinoko/ext`, "2-no-default.ts", "export const notDefault = 1;");
    writeExt(`${cwd}/.kinoko/ext`, "3-throws.ts", "export default function (): void { throw new Error('boom'); }");
    writeExt(`${cwd}/.kinoko/ext`, "4-fine.ts", "export default function (k: { log: (m: string) => void }): void { k.log('fine loaded'); }");

    const loaded = await loadExtensions(ext, { cwd: cwd, home: home });
    expect(loaded.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual(["4-fine.ts"]);
    expect(log.some((l) => l.includes("failed to load") && l.includes("1-syntax.ts"))).toBe(true);
    expect(log.some((l) => l.includes("no default export") && l.includes("2-no-default.ts"))).toBe(true);
    expect(log.some((l) => l.includes("boom"))).toBe(true);
  });
});

describe("extension events", () => {
  test("3. tool_call may mutate args and may block, with the reason as the tool result", async () => {
    const { ext } = extBus();
    const seen: unknown[] = [];
    const echo: Tool = {
      name: "echo",
      description: "",
      schema: {},
      run: async (args: unknown) => {
        seen.push(args);
        return `ran with ${JSON.stringify(args)}`;
      },
    };
    ext.on("tool_call", (call) => {
      if (call.name === "echo") call.args.tag = "added-by-extension";
    });
    ext.on("tool_call", (call) => {
      if (call.name !== "danger") return;
      return { block: true, reason: "permission-gate says no" };
    });

    const danger: Tool = {
      name: "danger",
      description: "",
      schema: {},
      run: async () => {
        throw new Error("a blocked tool must never run");
      },
    };
    const provider = providerFor([
      { name: "echo", args: { tag: "original" } },
      { name: "danger", args: { what: "rm -rf /" } },
    ]);
    const agent = new Agent({ provider, model: "m", system: "", tools: [echo, danger], maxTurns: 3, maxCost: 1, extensions: ext });
    const events: AgentEvent[] = [];
    agent.on((e) => events.push(e));
    await agent.prompt("go");

    expect(seen).toEqual([{ tag: "added-by-extension" }]);
    const results = agent.messages.filter((m: Message) => m.role === "tool");
    expect(results.map((m) => m.content)).toEqual([
      'ran with {"tag":"added-by-extension"}',
      "permission-gate says no",
    ]);
    // The blocked call is reported like any other tool activity, and never ran.
    expect(events.filter((e) => e.type === "tool_output").length).toBe(2);
    const blocked = events.find((e) => e.type === "tool_output" && e.call.name === "danger");
    expect((blocked as { output: string }).output).toBe("permission-gate says no");
  });

  test("4. a throwing handler is skipped and the run continues", async () => {
    const { ext, log } = extBus();
    const after: string[] = [];
    ext.on("tool_result", () => {
      throw new Error("handler exploded");
    });
    ext.on("tool_result", (r) => after.push(r.name));
    ext.on("turn_end", () => {
      throw new Error("turn handler exploded");
    });
    const echo: Tool = { name: "echo", description: "", schema: {}, run: async () => "fine" };
    const danger: Tool = {
      name: "danger",
      description: "",
      schema: {},
      run: async () => {
        throw new Error("a blocked tool must never run");
      },
    };
    const provider = providerFor([
      { name: "echo", args: { tag: "original" } },
      { name: "danger", args: { what: "rm -rf /" } },
    ]);
    const agent = new Agent({ provider, model: "m", system: "", tools: [echo, danger], maxTurns: 3, maxCost: 1, extensions: ext });
    const result = await agent.prompt("go");

    expect(result.reason).toBe("done");
    expect(after).toEqual(["echo"]);
    expect(agent.messages.at(-1)!.content).toBe("done");
    expect(log.filter((l) => l.includes("threw, skipping")).length).toBeGreaterThanOrEqual(2);
  });

  test("5. a registered tool is callable by the agent, and commands are reachable", async () => {
    const { ext } = extBus();
    ext.registerTool({
      name: "hello",
      description: "",
      schema: {},
      run: async (args: unknown) => `hello, ${(args as { name: string }).name}`,
    });
    ext.registerCommand("greet", (args) => `hi ${args}`);

    const agent = new Agent({ provider: providerFor([{ name: "hello", args: { name: "kinoko" } }]), model: "m", system: "", tools: ext.tools(), maxTurns: 3, maxCost: 1, extensions: ext });
    await agent.prompt("say hello to kinoko");
    const result = agent.messages.find((m: Message) => m.role === "tool");
    expect(result!.content).toBe("hello, kinoko");
    expect(await ext.command("greet")!("kinoko")).toBe("hi kinoko");
    expect(ext.commandNames()).toEqual(["greet"]);
    expect(ext.command("nope")).toBeUndefined();
  });

  test("6. context rewrites the request without touching the real history", async () => {
    const { ext } = extBus();
    const seen: number[] = [];
    const sent: string[] = [];
    ext.on("context", (messages) => messages.filter((m) => m.content !== "drop me"));
    ext.on("context", (messages) => [...messages, { id: "extra", role: "user", content: "injected" }]);
    ext.on("before_provider_request", (req) => {
      seen.push(req.messages.length);
      req.model = "rewritten";
    });
    const provider: Provider = {
      stream: async function* (req): AsyncIterable<StreamEvent> {
        expect(req.model).toBe("rewritten");
        sent.push(req.messages.map((m) => m.content).join("|"));
        yield { type: "text", delta: "ok" };
        yield { type: "done", stop: "end" };
      },
    };
    const agent = new Agent({ provider, model: "m", system: "", tools: [], maxTurns: 4, maxCost: 1, extensions: ext });
    await agent.prompt("keep me");
    await agent.prompt("drop me");

    expect(seen).toEqual([2, 3]); // turn 2 also carries the assistant reply
    expect(sent).toEqual(["keep me|injected", "keep me|ok|injected"]);
    // The drop only happened in the copy: the log the model and the session keep is intact.
    expect(agent.messages.map((m) => m.content)).toContain("drop me");
  });
});

/** Installs the example files the way a user would, and loads them. */
async function install(files: string[], tag: string): Promise<Extensions> {
  const home = `${ROOT}/${tag}`;
  const dir = `${home}/.kinoko/ext`;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(`${EXAMPLES}/${file}`, join(dir, file));
  const { ext } = extBus();
  const loaded = await loadExtensions(ext, { cwd: `${ROOT}/no-such-project`, home: home });
  expect(loaded).toHaveLength(files.length);
  return ext;
}

describe("the shipped example", () => {
  test("9. hello registers a tool and a command", async () => {
    const ext = await install(["hello.ts"], "hello");
    expect(ext.tools().map((t) => t.name)).toEqual(["hello"]);
    expect(await ext.command("hello")!("kinoko")).toBe("hello, kinoko");
    expect(await ext.command("hello")!("")).toBe("hello, world");
    expect(await ext.tools()[0]!.run({ name: "kinoko" }, { signal: new AbortController().signal, cwd: ROOT })).toContain("kinoko");
  });
});

/** Fake provider: calls the given tools on turn one, then answers. */
function providerFor(calls: Array<{ name: string; args: unknown }>): Provider {
  let turn = 0;
  return {
    stream: async function* (): AsyncIterable<StreamEvent> {
      turn++;
      if (turn === 1) {
        for (const [i, call] of calls.entries()) {
          yield { type: "tool_call", call: { id: `c${i}`, name: call.name, args: call.args } };
        }
        yield { type: "done", stop: "tool_use" };
        return;
      }
      yield { type: "text", delta: "done" };
      yield { type: "done", stop: "end" };
    },
  };
}