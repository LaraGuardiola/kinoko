import { expect, test } from "bun:test";
import { liveRegion } from "./view.ts";

test("live region fills viewport so editor and status stay at the bottom", () => {
  const region = liveRegion({
    stream: "answer",
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
  expect(region.lines[0]).toBe("answer");
  expect(region.lines[4]).toBe("> ");
  expect(region.lines[5]).toContain("type a prompt");
  expect(region.lines[6]).toBe(" IDLE ");
  expect(region.lines.slice(7)).toEqual(["", "", ""]);
  expect(region.row).toBe(4);
});

test("live region reserves the bottom rows for the editor on a short viewport", () => {
  const region = liveRegion({
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

  expect(region.lines[0]).toBe("> ab…\x1b[0m");
  expect(region.col).toBe(5);
});

test("thinking is dim italic text above the streamed answer", () => {
  const region = liveRegion({
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
