import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceRenderers } from "../../serve/renderers.ts";
import { renderMarkdown, setFenceRenderers } from "../../tui/markdown.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-renderers-"));
afterAll(() => {
  setFenceRenderers(() => undefined);
  rmSync(home, { recursive: true, force: true });
});

const ext = join(home, ".kinoko", "ext");
const disabled = join(home, ".kinoko", "disabled.json");
mkdirSync(ext, { recursive: true });
writeFileSync(join(ext, "boxes.ts"), 'export default (k) => k.registerRenderer("boxes", () => ["[drawn]"]);\n');

/** Written with a given mtime: the change is seen even within the same millisecond. */
function switchOff(names: string[], at: number): void {
  writeFileSync(disabled, JSON.stringify({ extensions: names, skills: [] }));
  utimesSync(disabled, at, at);
}

const drawn = (): boolean => renderMarkdown("```boxes\nx\n```", { width: 40 }).includes("[drawn]");

describe("the hub's fence renderers", () => {
  test("follow what is switched on, without restarting the hub", async () => {
    switchOff(["boxes"], 1000);
    const renderers = fenceRenderers(home);
    await renderers.fresh();
    expect(drawn()).toBe(false); // off when the hub started

    switchOff([], 2000); // switched on later (/extensions, a profile)
    await renderers.fresh();
    expect(drawn()).toBe(true);

    switchOff(["boxes"], 3000);
    await renderers.fresh();
    expect(drawn()).toBe(false);
  });
});
