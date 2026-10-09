import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { ImageRegistry, MAX_IMAGE_BYTES, clipboardImage, imageFromFile, imagePathOf, sniffMime, toImage } from "../../tui/images.ts";
import type { Run } from "../../tui/images.ts";

const ROOT = `${process.cwd()}/.tmp-images-test-${process.pid}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("pasted images", () => {
  test("numbers only grow; the text's placeholders pick the images, once each, in order", () => {
    const reg = new ImageRegistry();
    const a = { mime: "image/png", data: "A" };
    const b = { mime: "image/png", data: "B" };
    expect(reg.add(a)).toBe("[Image #1]");
    expect(reg.add(b)).toBe("[Image #2]");
    expect(reg.attached("see [Image #2] and [Image #1], again [Image #2]")).toEqual([b, a]);
    expect(reg.attached("deleted one: [Image #9], none: [Image #")).toEqual([]);
    const resumed = new ImageRegistry();
    resumed.startAfter(3); // a resumed session already holds three
    expect(resumed.add(a)).toBe("[Image #4]");
  });

  test("the media type comes from the bytes; empty, unknown and huge are refused with a reason", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(toImage(PNG)).toEqual({ mime: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(toImage(new Uint8Array())).toBe("no image in the clipboard");
    expect(toImage(new TextEncoder().encode("hello"))).toContain("not a PNG");
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(PNG);
    expect(toImage(huge)).toContain("too large");
  });

  test("a dropped or pasted image path: quoted, backslashed, file://, ~; anything else is text", () => {
    expect(imagePathOf("/tmp/shot.png")).toBe("/tmp/shot.png");
    expect(imagePathOf("'/tmp/my shot.PNG' ")).toBe("/tmp/my shot.PNG");
    expect(imagePathOf("/tmp/my\\ shot.jpg")).toBe("/tmp/my shot.jpg");
    expect(imagePathOf("file:///tmp/a%20b.webp")).toBe("/tmp/a b.webp");
    expect(imagePathOf("~/a.gif")).toBe(`${homedir()}/a.gif`);
    expect(imagePathOf("look at /tmp/a.png\nplease")).toBeUndefined();
    expect(imagePathOf("notes.md")).toBeUndefined();
  });

  test("files: read when they exist (relative to cwd), undefined when not", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/shot.png`, PNG);
    writeFileSync(`${ROOT}/fake.png`, "text");
    expect(await imageFromFile("shot.png", ROOT)).toEqual({ mime: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(await imageFromFile(`${ROOT}/fake.png`, "/")).toContain("not a PNG");
    expect(await imageFromFile("missing.png", ROOT)).toBeUndefined();
  });

  test("the clipboard: wl-paste on Wayland, xclip on X11, the type listed first", async () => {
    const asked: string[][] = [];
    const fake = (types: string, bytes = PNG): Run => async (cmd) => {
      asked.push(cmd);
      return cmd.includes("--list-types") || cmd.includes("TARGETS") ? new TextEncoder().encode(types) : bytes;
    };
    const signal = new AbortController().signal;
    expect(await clipboardImage(signal, fake("text/plain\nimage/png\n"), { WAYLAND_DISPLAY: "wayland-1" })).toEqual(toImage(PNG));
    expect(asked[1]).toEqual(["wl-paste", "--no-newline", "--type", "image/png"]);
    asked.length = 0;
    expect(await clipboardImage(signal, fake("TARGETS\nimage/jpeg"), { DISPLAY: ":0" })).toEqual(toImage(PNG));
    expect(asked[1]).toEqual(["xclip", "-selection", "clipboard", "-t", "image/jpeg", "-o"]);
    expect(await clipboardImage(signal, fake("text/plain"), { WAYLAND_DISPLAY: "w" })).toBe("no image in the clipboard");
    expect(await clipboardImage(signal, async () => undefined, { WAYLAND_DISPLAY: "w" })).toContain("is wl-paste (wl-clipboard) installed?");
    expect(await clipboardImage(signal, fake("image/png"), {})).toContain("needs Wayland or X11");
  });
});
