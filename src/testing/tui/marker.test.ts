import { expect, test } from "bun:test";
import { Marker } from "../../tui/marker.ts";

test("the marker keeps the last note and how it is drawn", () => {
  const marker = new Marker();
  expect([marker.text, marker.tone]).toEqual(["", "warning"]);
  marker.inform("copied: 3 lines");
  expect([marker.text, marker.tone]).toEqual(["copied: 3 lines", "info"]);
  marker.alert("Interrupted");
  expect(marker.tone).toBe("alert");
  marker.warn("no plan yet");
  expect([marker.text, marker.tone]).toEqual(["no plan yet", "warning"]);
  marker.clear();
  expect(marker.text).toBe("");
});
