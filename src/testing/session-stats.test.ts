import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Session } from "../session.ts";
import { listSessions, toolStats, totals } from "../session-stats.ts";
import { toolsLine, toolsTable } from "../tui/sessions-menu.ts";
import { stripAnsi } from "../tui/style.ts";
import type { Message } from "../types.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-stats-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
const msg = (m: Omit<Message, "id">): Message => ({ id: `m${n++}`, ...m });

describe("session stats", () => {
  test("each tool's calls: an ERROR result is an error, a non-zero exit a failure, the rest went well", () => {
    const messages = [
      msg({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "bash", args: {} }, { id: "b", name: "bash", args: {} }, { id: "c", name: "read", args: {} }, { id: "d", name: "bash", args: {} }] }),
      msg({ role: "tool", toolCallId: "a", content: "ok" }),
      msg({ role: "tool", toolCallId: "b", content: "make: *** Error\n\n[exit code 2]" }),
      msg({ role: "tool", toolCallId: "c", content: "ERROR: file not found: x" }),
      msg({ role: "tool", toolCallId: "d", content: "a log line saying [exit code 1] in passing, then more" }),
    ];
    expect(toolStats(messages)).toEqual([
      { name: "bash", calls: 3, errors: 0, failed: 1 },
      { name: "read", calls: 1, errors: 1, failed: 0 },
    ]);
  });

  test("a directory's sessions: latest first, empty ones left out, kinoko's notes are not prompts; all added up", async () => {
    const cwd = "/some/project";
    const older = await Session.create({ cwd, model: "/models/Qwen3.6.gguf", home });
    await older.append(msg({ role: "user", content: "pon   música\nen el altavoz" }));
    await older.append(msg({ role: "assistant", content: "", toolCalls: [{ id: "x", name: "music", args: {} }], usage: { input: 1000, output: 50, cacheRead: 400 } }));
    await older.append(msg({ role: "tool", toolCallId: "x", content: "▶ playing" }));
    await older.append(msg({ role: "user", content: "[kinoko] Background job #1 finished" }));
    await older.append(msg({ role: "assistant", content: "hecho", usage: { input: 1200, output: 10, cacheRead: 1000 } }));
    await Session.create({ cwd, model: "m", home }); // nothing said: not listed
    await Bun.sleep(15);
    const newer = await Session.create({ cwd, model: "m", home });
    await newer.append(msg({ role: "user", content: "hola" }));
    await newer.append(msg({ role: "assistant", content: "buenas", usage: { input: 10, output: 2 } }));

    const list = await listSessions(dirname(newer.path));
    expect(list.map((s) => s.id)).toEqual([newer.meta.id, older.meta.id]);
    const first = list[1]!;
    expect(first).toMatchObject({ first: "pon música en el altavoz", models: ["Qwen3.6"], messages: 5, prompts: 1, replies: 2, sent: 2200, generated: 60, cached: 1400, compactions: 0 });
    expect(first.tools).toEqual([{ name: "music", calls: 1, errors: 0, failed: 0 }]);
    expect(totals(list)).toMatchObject({ sessions: 2, sent: 2210, generated: 62, prompts: 2, models: ["m", "Qwen3.6"] });
    expect(await listSessions(join(home, "nowhere"))).toEqual([]);
  });

  test("the tools in a line, and one row each with how it went", () => {
    const tools = [{ name: "bash", calls: 12, errors: 1, failed: 2 }, { name: "read", calls: 5, errors: 0, failed: 0 }];
    expect(toolsLine(tools)).toBe("bash 12 (1 error, 2 failed) · read 5");
    expect(toolsLine([])).toBe("none");
    const table = stripAnsi(toolsTable(tools, 80).join("\n"));
    expect(table).toContain("Success");
    expect(table).toMatch(/bash\s*│\s*12\s*│\s*9\s*│\s*1\s*│\s*2\s*│\s*75%/);
    expect(toolsTable([], 80)).toEqual(["  no tools were called"]);
  });
});
