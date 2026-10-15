// The hub's voice for the phone (docs/phone-voice.md): GET /v1/speech says whether this computer can
// speak, POST /v1/speech turns one sentence into speech, streamed as it is made (raw 16-bit mono PCM).
// The backend is the "tts" of ~/.kinoko/voice.json, the block the voice extension uses (its README):
// an OpenAI-compatible /v1/audio/speech, or a program reading the text on stdin. The extension's own
// request lives in another repository the core cannot import: these few lines repeat it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expandHome } from "./dirs.ts";

/** Where the voice is set up: ~/.kinoko/voice.json and the cloned voices beside it. */
export interface SpeechPlace {
  config: string;
  voices: string;
}

type Tts = ({ http: string; key?: string } | { command: string[] }) & {
  voice?: string;
  model?: string;
  language?: string;
  temperature?: number;
  rate?: number;
};

/** The longest sentence spoken at once: the app sends one sentence, not a reply. */
const MAX_TEXT = 2_000;

async function readTts(file: string): Promise<Tts | string> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return `no ${file}`;
  let tts: unknown;
  try {
    tts = (JSON.parse(raw) as { tts?: unknown }).tts;
  } catch {
    return `${file} is not JSON`;
  }
  if (typeof tts !== "object" || tts === null) return `no "tts" in ${file}`;
  const t = tts as Record<string, unknown>;
  if (typeof t.http === "string" || (Array.isArray(t.command) && t.command.length > 0 && t.command.every((a) => typeof a === "string"))) return t as Tts;
  return `"tts" in ${file} has neither "http" nor "command"`;
}

/** GET and POST /v1/speech. */
export async function speech(req: Request, place: SpeechPlace | undefined): Promise<Response> {
  const tts = place ? await readTts(place.config) : "no voice set up for the hub";
  if (req.method === "GET") return Response.json(typeof tts === "string" ? { available: false, why: tts } : { available: true, voice: tts.voice ?? null, language: tts.language ?? null });
  if (req.method !== "POST") return Response.json({ error: "GET or POST" }, { status: 405 });
  if (typeof tts === "string" || place === undefined) return Response.json({ error: typeof tts === "string" ? tts : "no voice" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  if (text === "") return Response.json({ error: "text: the sentence to speak" }, { status: 400 });
  const headers = { "content-type": `audio/pcm; rate=${tts.rate ?? 24_000}` };
  try {
    if ("command" in tts) {
      // Cancelled with the request: the phone stopped listening.
      const proc = Bun.spawn(tts.command.map((a) => (a.startsWith("~") ? expandHome(a) : a)), { stdin: "pipe", stdout: "pipe", stderr: "ignore", signal: req.signal });
      await proc.stdin.write(text);
      await proc.stdin.end();
      return new Response(proc.stdout, { headers });
    }
    let res = await ask(tts, text, req.signal);
    // qwentts.cpp forgets cloned voices when it restarts: taught again, asked again, once.
    if (res.status === 400 && tts.voice && /unknown voice/i.test(await res.clone().text())) {
      if (await teach(tts.http, tts.voice, place.voices, req.signal)) res = await ask(tts, text, req.signal);
    }
    if (!res.ok || res.body === null) return Response.json({ error: `${tts.http} answered ${res.status}: ${(await res.text()).slice(0, 200)}` }, { status: 502 });
    return new Response(res.body, { headers });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

function ask(tts: Tts & { http: string; key?: string }, text: string, signal: AbortSignal): Promise<Response> {
  const body = { model: tts.model ?? "tts", input: text, voice: tts.voice, language: tts.language, temperature: tts.temperature, response_format: "pcm" };
  return fetch(tts.http, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(tts.key ? { authorization: `Bearer ${tts.key}` } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * A cloned voice taught to qwentts.cpp (POST /v1/audio/voices) from `<dir>/<name>.txt` (what the clip
 * says) with `.spk` and `.rvq` (encoded ahead: nothing for the GPU to encode) or the `.wav`.
 */
async function teach(speechUrl: string, name: string, dir: string, signal: AbortSignal): Promise<boolean> {
  const file = (ext: string): Promise<Buffer | undefined> => readFile(join(dir, `${name}${ext}`)).catch(() => undefined);
  const [txt, spk, rvq, wav] = await Promise.all([file(".txt"), file(".spk"), file(".rvq"), file(".wav")]);
  const audio = spk && rvq ? { spk_b64: spk.toString("base64"), rvq_b64: rvq.toString("base64") } : wav ? { wav_b64: wav.toString("base64") } : undefined;
  if (audio === undefined) return false;
  const url = speechUrl.replace(/\/speech$/, "/voices");
  const res = await fetch(url, { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ref_text: txt?.toString("utf8").trim() ?? "", ...audio }) }).catch(() => undefined);
  return res?.ok === true;
}
