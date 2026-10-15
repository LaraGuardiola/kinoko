import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../serve/server.ts";
import { Devices } from "../../serve/devices.ts";

const dir = mkdtempSync(join(tmpdir(), "kinoko-speech-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A text-to-speech server like qwentts.cpp: knows only the voices taught to it, streams PCM. */
function fakeTts(): { url: string; asked: unknown[]; taught: Record<string, unknown>[]; stop: () => void } {
  const asked: unknown[] = [];
  const taught: Record<string, unknown>[] = [];
  const known = new Set<string>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as Record<string, unknown>;
      if (url.pathname === "/v1/audio/voices") {
        taught.push(body);
        known.add(String(body.name));
        return Response.json({ ok: true });
      }
      asked.push(body);
      if (body.voice !== undefined && !known.has(String(body.voice))) return Response.json({ error: { message: `unknown voice '${String(body.voice)}'` } }, { status: 400 });
      if (body.input === "fail") return new Response("broken", { status: 500 });
      // Two pieces, the second a moment later: streamed, not gathered.
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(Uint8Array.of(1, 2, 3, 4));
          await Bun.sleep(20);
          c.enqueue(Uint8Array.of(5, 6));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1/audio/speech`, asked, taught, stop: () => void server.stop(true) };
}

async function hub(name: string, tts: unknown): Promise<{ base: string; auth: { authorization: string }; stop: () => void }> {
  const home = join(dir, name);
  mkdirSync(join(home, "voices"), { recursive: true });
  if (tts !== undefined) writeFileSync(join(home, "voice.json"), JSON.stringify({ tts }));
  writeFileSync(join(home, "voices", "wheatley.txt"), "Hola, soy Wheatley.\n");
  writeFileSync(join(home, "voices", "wheatley.spk"), "spk");
  writeFileSync(join(home, "voices", "wheatley.rvq"), "rvq");
  const devices = new Devices(join(home, "serve.json"));
  const h = serve({ port: 0, devices, command: ["kinoko"], sessionsDir: home, version: "t", speech: { config: join(home, "voice.json"), voices: join(home, "voices") } });
  const base = `http://127.0.0.1:${h.server.port}`;
  const { token } = (await (await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: await devices.code(), name: "phone" }) })).json()) as { token: string };
  return { base, auth: { authorization: `Bearer ${token}` }, stop: h.stop };
}

const say = (h: { base: string; auth: object }, text: string): Promise<Response> =>
  fetch(`${h.base}/v1/speech`, { method: "POST", headers: { ...h.auth, "content-type": "application/json" }, body: JSON.stringify({ text }) });

describe("the hub's speech", () => {
  test("a sentence's audio streams through; a forgotten voice is taught again, once", async () => {
    const tts = fakeTts();
    const h = await hub("http", { http: tts.url, voice: "wheatley", language: "Spanish" });
    try {
      expect(await (await fetch(`${h.base}/v1/speech`, { headers: h.auth })).json()).toEqual({ available: true, voice: "wheatley", language: "Spanish" });
      const res = await say(h, " Vale, lo he mirado. ");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/pcm; rate=24000");
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
      expect(tts.taught).toEqual([{ name: "wheatley", ref_text: "Hola, soy Wheatley.", spk_b64: btoa("spk"), rvq_b64: btoa("rvq") }]);
      expect(tts.asked).toHaveLength(2); // refused, then spoken
      expect(tts.asked[1]).toMatchObject({ input: "Vale, lo he mirado.", voice: "wheatley", language: "Spanish", response_format: "pcm" });
      // Known now: asked once.
      await (await say(h, "Otra.")).arrayBuffer();
      expect(tts.asked).toHaveLength(3);
      expect(tts.taught).toHaveLength(1);
      expect((await say(h, "fail")).status).toBe(502);
      expect((await say(h, "   ")).status).toBe(400);
    } finally {
      h.stop();
      tts.stop();
    }
  });

  test.skipIf(process.platform === "win32")("a command backend: the sentence on its stdin, its stdout back", async () => {
    const h = await hub("command", { command: ["sh", "-c", "tr a-z A-Z"], rate: 16000 });
    try {
      const res = await say(h, "hola");
      expect(res.headers.get("content-type")).toBe("audio/pcm; rate=16000");
      expect(await res.text()).toBe("HOLA");
    } finally {
      h.stop();
    }
  });

  test("not paired: 401; nothing set up: unavailable, and 503 when asked", async () => {
    const h = await hub("none", undefined);
    try {
      expect((await fetch(`${h.base}/v1/speech`)).status).toBe(401);
      const got = (await (await fetch(`${h.base}/v1/speech`, { headers: h.auth })).json()) as { available: boolean; why: string };
      expect(got.available).toBe(false);
      expect(got.why).toContain("voice.json");
      expect((await say(h, "hola")).status).toBe(503);
    } finally {
      h.stop();
    }
  });
});
