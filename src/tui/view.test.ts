import { expect, test } from "bun:test";
import { liveRegion, wrapAnsi } from "./view.ts";

const stripAnsi = (line: string): string => line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");

test("live region fills viewport with editor and status at the active region bottom", () => {
  const region = liveRegion({
    transcript: [],
    stream: "",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
    viewportRows: 10,
  });

  expect(region.lines).toHaveLength(10);
  expect(region.lines[4]).toBe("> ");
  expect(region.lines[5]).toContain("type a prompt");
  expect(region.lines[6]).toBe(" IDLE ");
  expect(region.lines.slice(7)).toEqual(["", "", ""]);
  expect(region.row).toBe(4);
});

test("live region reserves the bottom rows for the editor on a short viewport", () => {
  const region = liveRegion({
    transcript: [],
    stream: "one\ntwo\nthree\nfour",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: ["draft"],
    editorEmpty: false,
    editorRow: 0,
    editorCol: 5,
    status: " IDLE ",
    viewportRows: 3,
  });

  expect(region.lines).toEqual(["> draft", " IDLE ", ""]);
  expect(region.row).toBe(0);
});

test("live region clips styled rows before the terminal margin", () => {
  const region = liveRegion({
    transcript: [],
    stream: "",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: ["abcdef"],
    editorEmpty: false,
    editorRow: 0,
    editorCol: 6,
    status: " IDLE ",
    viewportRows: 3,
    viewportCols: 6,
  });

  expect(region.lines[0]).toBe("> a…\x1b[0m");
  expect(region.col).toBe(4);
});

test("thinking is dim italic text above the streamed answer", () => {
  const region = liveRegion({
    transcript: [],
    stream: "answer",
    thinking: "reasoning",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
  });

  expect(region.lines[0]).toBe("\x1b[2m\x1b[3mreasoning\x1b[0m");
  expect(region.lines[1]).toBe("answer");
});

test("submitted user messages render in light blue in the live transcript", () => {
  const region = liveRegion({
    transcript: [
      { role: "user", text: "help me" },
      { role: "user", text: "another\nmessage" },
    ],
    stream: "",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
  });

  expect(region.lines[0]).toBe("\x1b[38;5;159m> help me\x1b[0m");
  expect(region.lines[1]).toBe("\x1b[38;5;159m> another\x1b[0m");
  expect(region.lines[2]).toBe("\x1b[38;5;159m> message\x1b[0m");
});

test("completed assistant output remains in the live transcript", () => {
  const region = liveRegion({
    transcript: [
      { role: "user", text: "question" },
      { role: "assistant", text: "answer remains visible" },
    ],
    stream: "",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
  });

  expect(region.lines).toContain("answer remains visible");
});

test("completed thinking remains dim and italic in the live transcript", () => {
  const region = liveRegion({
    transcript: [{ role: "thinking", text: "reasoning remains visible" }],
    stream: "",
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: true,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
  });

  expect(region.lines[0]).toBe("\x1b[2m\x1b[3mreasoning remains visible\x1b[0m");
});

test("long transcript rows wrap to the full width instead of ending in an ellipsis", () => {
  const region = liveRegion({
    transcript: [{ role: "user", text: "hola ".repeat(30) }],
    stream: "x ".repeat(50),
    thinking: "",
    tool: undefined,
    marker: "",
    queued: [],
    editorLines: [""],
    editorEmpty: false,
    editorRow: 0,
    editorCol: 0,
    status: " IDLE ",
    viewportRows: 20,
    viewportCols: 40,
  });

  for (const line of region.lines) {
    expect(stripAnsi(line).length).toBeLessThanOrEqual(38);
  }
  expect(region.lines.some((line) => line.includes("…"))).toBe(false);
  // The user color survives the split across rows.
  expect(region.lines[0]).toContain("\x1b[38;5;159m");
  expect(region.lines[1]).toContain("\x1b[38;5;159m");
});

test("wrapAnsi keeps styles across split rows and leaves fitting rows alone", () => {
  expect(wrapAnsi("short", 10)).toEqual(["short"]);
  const rows = wrapAnsi("\x1b[1mboldtextthatiswaytoolong\x1b[0m", 10);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toBe("\x1b[1mboldtextth\x1b[0m");
  expect(rows[1]).toBe("\x1b[1matiswaytoo\x1b[0m");
});
