import { expect, test, describe, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverContext, discoverSkills, frontmatter, renderContext, renderSkills } from "../context.ts";

const ROOT = join(process.cwd(), `.tmp-ctx-test-${process.pid}`);
const HOME = join(ROOT, "home");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Relative paths of the files found under ROOT, so ancestors outside it do not matter. */
function underRoot(files: { path: string }[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) => p.startsWith(ROOT))
    .map((p) => p.slice(ROOT.length + 1).replaceAll("\\", "/")); // compared as posix paths
}

describe("context discovery", () => {
  test("1. walks up to the root and returns instruction files ROOT-FIRST", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    write(join(ROOT, "AGENTS.md"), "root rules\n");
    write(join(ROOT, "mid/CLAUDE.md"), "mid rules\n");
    write(join(ROOT, "mid/deep/AGENTS.md"), "deep rules\n");
    write(join(ROOT, "mid/deep/src/notes.md"), "not instructions\n");

    const fromDeep = await discoverContext(join(ROOT, "mid/deep/src"));
    expect(underRoot(fromDeep)).toEqual(["AGENTS.md", "mid/CLAUDE.md", "mid/deep/AGENTS.md"]);
    // The root file is the most general, so it is always first.
    expect(underRoot(fromDeep)[0]).toBe("AGENTS.md");

    // Starting higher up drops the deeper files.
    expect(underRoot(await discoverContext(join(ROOT, "mid")))).toEqual(["AGENTS.md", "mid/CLAUDE.md"]);
  });

  test("2. AGENTS.md wins over CLAUDE.md in the same directory", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    write(join(ROOT, "AGENTS.md"), "agents\n");
    write(join(ROOT, "CLAUDE.md"), "claude\n");
    const found = await discoverContext(ROOT);
    expect(underRoot(found)).toEqual(["AGENTS.md"]);
    expect(found.find((f) => f.path === join(ROOT, "AGENTS.md"))!.body).toBe("agents"); // trailing newline trimmed, so blocks never double-space
    // Ancestors outside the fixture (this repo's own AGENTS.md) are still found, and come first.
    expect(found.indexOf(found.find((f) => f.path === join(ROOT, "AGENTS.md"))!)).toBe(found.length - 1);
  });

  test("3. each file is wrapped in its own ctx block", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    write(join(ROOT, "AGENTS.md"), "root rules\n");
    const rendered = renderContext(await discoverContext(ROOT));
    expect(rendered).toContain(`<ctx path="${join(ROOT, "AGENTS.md")}">\nroot rules\n</ctx>`);
    expect(renderContext([])).toBe("");
  });

  test("4. skills index: project first, then home, name and description only", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    write(
      join(ROOT, "proj/.agents/skills/zeta/SKILL.md"),
      "---\nname: zeta-skill\ndescription: does zeta things\n---\n\n# Body\nshould never be indexed\n",
    );
    write(
      join(ROOT, "proj/.agents/skills/alpha/SKILL.md"),
      '---\nname: "alpha-skill"\ndescription: "handles alpha"\n---\nbody\n',
    );
    write(join(HOME, ".agents/skills/gamma/SKILL.md"), "---\ndescription: home skill\n---\nbody\n");

    const skills = await discoverSkills(join(ROOT, "proj"), HOME);
    expect(skills.map((s) => s.name)).toEqual(["alpha-skill", "zeta-skill", "gamma"]); // home last, sorted
    expect(skills[1]!.description).toBe("does zeta things");
    expect(skills[2]!.name).toBe("gamma"); // no name in frontmatter: the directory name is used

    const index = renderSkills(skills);
    expect(index).toBe(
      [
        "<skills>",
        `<skill path="${join(ROOT, "proj/.agents/skills/alpha/SKILL.md")}" name="alpha-skill">handles alpha</skill>`,
        `<skill path="${join(ROOT, "proj/.agents/skills/zeta/SKILL.md")}" name="zeta-skill">does zeta things</skill>`,
        `<skill path="${join(HOME, ".agents/skills/gamma/SKILL.md")}" name="gamma">home skill</skill>`,
        "</skills>",
      ].join("\n"),
    );
    expect(index).not.toContain("should never be indexed");
    expect(renderSkills([])).toBe("");
  });

  test("4b. skills are unique: cwd == home scans once, and a project skill shadows a home one", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    write(join(HOME, ".agents/skills/omarchy/SKILL.md"), "---\nname: omarchy\n---\n");
    expect((await discoverSkills(HOME, HOME)).map((s) => s.name)).toEqual(["omarchy"]);
    // Installed from /skills: read after the shared ones; a shared skill of the same name wins.
    write(join(HOME, ".kinoko/skills/write-ext/SKILL.md"), "---\nname: write-ext\ndescription: from the catalog\n---\n");
    write(join(HOME, ".kinoko/skills/omarchy/SKILL.md"), "---\nname: omarchy\ndescription: shadowed\n---\n");
    expect((await discoverSkills(HOME, HOME)).map((s) => `${s.name}:${s.description}`)).toEqual(["omarchy:", "write-ext:from the catalog"]);

    write(join(ROOT, "proj/.agents/skills/mine/SKILL.md"), "---\nname: omarchy\ndescription: project\n---\n");
    const skills = await discoverSkills(join(ROOT, "proj"), HOME);
    expect(skills.map((s) => s.description)).toEqual(["project", "from the catalog"]);
  });

  test("5. frontmatter reads name and description, quoting included", () => {
    expect(frontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\nbody')).toEqual({
      name: "quoted",
      description: "single",
    });
    expect(frontmatter("no frontmatter here")).toEqual({});
    expect(frontmatter("---\nname: x\ndescription: y")).toEqual({}); // unterminated
    expect(frontmatter("---\nname: x\nother: z\ndescription: d\n---\n")).toEqual({ name: "x", description: "d" });
  });

  test("5b. frontmatter joins multi-line values: > and | blocks, wrapped plain text", () => {
    const folded = "---\nname: send-files\ndescription: >\n  Send files to the phone.\n\n  Triggers: send, phone.\nother: z\n---\n";
    expect(frontmatter(folded)).toEqual({ name: "send-files", description: "Send files to the phone. Triggers: send, phone." });
    expect(frontmatter("---\ndescription: |-\n  line one\n  line two\n---\n").description).toBe("line one line two");
    expect(frontmatter("---\ndescription: starts here\n  and wraps\nname: n\n---\n")).toEqual({
      description: "starts here and wraps",
      name: "n",
    });
    expect(frontmatter("---\nmeta:\n  name: nested\n---\n")).toEqual({}); // indented keys belong to another map
  });
});