# Voice: talking with kinoko (design)

"The dream of talking with robots" (the owner, 2026-10-14). Three features for the TUI:

- **Dictation (STT)**: a key starts recording, the same key stops it, and the words land in the
  editor to read over before sending. Pluggable backends.
- **Speech (TTS)**, "the dream": kinoko reads its replies aloud **while the model writes them**,
  sentence by sentence, in a cloned voice of your choosing, Spanish with a Spain accent, and
  **it can be cut** like a run (Esc).
- **Conversation**, the goal: kinoko listens for as long as it is open. Say something and it is a
  prompt; say something **while it talks or works** and it stops talking and takes it as a steer
  **at once** (barge-in). Section 4b.

For the owner and for their partner, so Spanish first, multilingual welcome. Nothing is built
yet: section 6 is the order of work, section 7 the questions still open.

## 1. What the spike measured (this machine, 2026-10-14)

RTX 4070 Laptop (8 GB), i7-14700HX, LFM2.5-24B-A2B Q6 on llama-server holding 7.45 GB of VRAM.

**Speech: Qwen3-TTS** (Apache 2.0, 10 languages, clones from a few seconds of audio), through
**qwentts.cpp**, a C++/GGML port with `tts-server`: OpenAI-compatible `/v1/audio/speech`, raw PCM
streamed as it is generated, cloned voices registered over HTTP (`/v1/audio/voices`).

| | First audio | Speed (RTF: time to make / length of the audio) | VRAM |
|---|---|---|---|
| CPU, 0.6B, 8 P-core threads | 0.2 s | 0.99 alone, **1.39 while the LLM writes**: falls behind | 0 |
| **CUDA, 1.7B Q4_K_M** (the better voice) | **0.03–0.1 s** | **0.16–0.19**, also while the LLM writes | ~2.6 GB |

The GPU is the way. Both fit with `NCMOE=36 ~/bin/lfm-serve.sh` (default 31): the LLM alone
35.2 tok/s generating, 847 tok/s reading (vs ~36 / ~1070); with the TTS talking nonstop, 28.5.
The TTS works about a fifth of the time it speaks, so the real cost is a few percent.

The default Spanish voice sounds Latin American; **the accent comes from the reference** when
cloning. A clone from 11 s of Spain-Spanish game dialogue (Wheatley, Portal 2) kept the accent
and the character; its expressive line was the owner's favourite.

**Dictation: whisper.cpp, large-v3-turbo q5_0** (574 MB) on the CPU: 8 minutes of Spain-Spanish
speech in 2 m 43 s, clean punctuation. Dictation happens while the model is idle, so the CPU is
free; a 10 s phrase should take 1–3 s (to measure in step 2). Parakeet TDT v3 is the fast
alternative if that is not enough.

Others looked at: Chatterbox Multilingual v3 (MIT, 23 languages, the "beats ElevenLabs" one, needs
the GPU, no CPU numbers), Voxtral TTS (non-commercial, cloning only through Mistral's API),
Kokoro and Piper (no cloning; Kokoro's Spanish is weak).

## 2. Shape: one extension, three small hooks in the core

Policy lives in extensions, so the voice is **one extension, `voice`, in kinoko-extensions**: it
records, calls the backends, splits the text, plays the audio. kinoko does not start or manage the
speech servers (they are services, like llama-server); the extension's README says how to run them.

The core grows three hooks, each small and useful to other extensions:

1. **`k.on("agent_event", (event) => …)`**: every AgentEvent the TUI sees (src/agent-events.ts),
   read-only. The voice needs `message_delta` (the reply as it streams), `run_start` and `run_end`.
   One general hook instead of a new event per need.
2. **`k.on("interrupt", () => …)`**: the user asked for quiet: Esc or Ctrl-C, **also while idle**
   (today Esc does nothing then). The first Esc after a run stops the voice.
3. **`k.registerKey(key, description, handler)`**, TUI only: the handler gets `insert(text)` (into
   the editor at the cursor) and `status(text | undefined)` (a line under the editor:
   "● recording 0:04", "transcribing…"). Listed in /help. Core keys cannot be taken.

Zero runtime dependencies: `fetch`, `Bun.spawn`, PipeWire's `pw-record` and `pw-play`.

## 3. Dictation

- **Ctrl+Space** (proposed): starts `pw-record` (16 kHz mono WAV in a temp file); the same key stops
  it, the backend transcribes, the text goes into the editor. **Not sent**: Enter sends, as always.
- Esc while recording throws the recording away. Two minutes at most.
- Terminals do not report key releases, so it is a toggle, not hold-to-talk.

## 4. Speech

- **What is read**: the reply's text only. No thinking, no tool calls or results, no code blocks or
  tables ("the code is on screen" once, instead). Markdown marks dropped, a link read as its text.
- **Sentence by sentence**: the deltas are cut at sentence ends (`. ? ! :` and line breaks, minding
  `3.5`, `e.g.`, `src/loop.ts`). Each sentence goes to the backend as soon as it is whole; the
  next is synthesized while the current one plays, so there are no gaps.
- **Playback**: the PCM streams from the HTTP response straight into `pw-play`; the first sound
  comes about 0.1 s after the sentence ends.
- **Cutting it** (docs/interruption.md: every await abortable): one AbortController per reply.
  `interrupt`, a new prompt, or `/voice off` aborts the requests in flight, kills `pw-play`, empties
  the queue. A run aborted with Esc stops its voice too.
- **Voices**: `~/.kinoko/voices/<name>.wav` plus `<name>.txt` (what it says). The extension
  registers them with the server when it starts and again if the server restarts.
  `/voice <name>` picks one, `/voice off` and `/voice on` toggle speech, `/voice` lists them.

## 4b. Conversation: always listening, barge-in

Turned on with `/voice listen` (until kinoko closes or `/voice listen off`), or the dictation key
held to its own job. While it is on, a line under the editor says so: "● listening".

- **The microphone streams** (`pw-record`, 16 kHz mono raw PCM on stdout) into the extension.
- **Voice activity**: a small detector in the extension (energy over a noise floor that adapts,
  with a short hangover; plain TypeScript, tested on recorded PCM) finds where speech starts and ends.
- **Barge-in**: 300 ms of speech while kinoko talks **cuts its voice at once** (the same path as
  Esc), before the words are even transcribed.
- **The utterance**: when ~700 ms of silence ends it, the segment goes to the STT backend, and the
  text becomes **a prompt when idle, a steer sent now when a run is going** (Alt+X's path: the
  reply being streamed is cut and the model reads the steer next). It shows in the transcript as
  the user's message, marked as spoken.
- **Noise is not a prompt**: empty transcripts and whisper's known hallucinations on silence
  ("Gracias.", "Subtítulos por…") are dropped; so is anything shorter than ~2 words, unless asked.
- **Its own voice is not the user**: kinoko speaks through the laptop's speakers and listens with
  its microphone, so without care it would interrupt itself. PipeWire's echo-cancel module
  (WebRTC AEC, installed here: `libpipewire-module-echo-cancel`, `libspa-aec-webrtc`) gives a
  microphone with what the speakers play taken out, cliamp's music included; the extension records
  from it. Part of this machine's setup (step 4). With headphones it is not needed.
- **The room**: an open microphone hears everyone (the TV, a call). An optional **wake word**
  (`"wake": "kinoko"`: only utterances that start with it count) and the key to mute it at once.

**Latency** (to measure): the end of speech ~0.7 s, the transcription ~0.5–1.5 s on the CPU, then
the model. In conversation the STT's speed matters more than in dictation: if the CPU is too slow,
a smaller whisper model, or the GPU with NCMOE a little higher.

Core hook 4, for this: **`k.send(text, { as: "prompt" | "steer_now" })`**, the extension speaking
for the user, exactly as if typed.

## 5. Backends (config: `~/.kinoko/voice.json`)

Two kinds, both for STT and TTS, so any engine fits:

```json
{
  "stt": { "http": "http://127.0.0.1:8092/v1/audio/transcriptions", "language": "es" },
  "tts": { "http": "http://127.0.0.1:8091/v1/audio/speech", "voice": "wheatley", "language": "Spanish" },
  "speak": true
}
```

- **`http`**: OpenAI-compatible (`/v1/audio/transcriptions`, `/v1/audio/speech`), which covers
  whisper.cpp's server (`--inference-path /v1/audio/transcriptions`), qwentts.cpp's `tts-server`, speaches, Kokoro-FastAPI, Chatterbox's server, and cloud
  APIs (with `"key"`).
- **`command`**: a program, for engines without a server: STT gets `{wav}` and prints the text; TTS
  reads the text on stdin and writes WAV or PCM to stdout (piper, `qwen-tts -o -`).

## 6. Order of work (one branch each, merged before the next)

1. **Core hooks** (kinoko, `feat/ext-voice-hooks`): `agent_event`, `interrupt` (and Esc while idle
   firing it), `registerKey` with `insert` and `status`, `send`. Tests. api.ts in kinoko-extensions.
2. **Dictation** (kinoko-extensions, `feat/voice-dictation`): recording, both backend kinds,
   `voice.json`. Measured on Spanish phrases.
3. **Speech** (kinoko-extensions, `feat/voice-speech`): the sentence splitter (tested hard), the
   queue, playback, cutting, voices, `/voice`. Checked by ear by the owner.
4. **This machine**: whisper.cpp and qwentts.cpp built with CUDA under `~/Projects`, models in place,
   `~/bin/tts-serve.sh` and `~/bin/stt-serve.sh` beside `lfm-serve.sh` (its NCMOE to 36), the
   Wheatley voice in `~/.kinoko/voices`, PipeWire's echo cancellation.
5. **Conversation** (kinoko-extensions, `feat/voice-listen`): the streaming microphone, voice
   activity, barge-in, utterances as prompts and steers, the wake word. Tuned by voice with the owner.

Not in this work: the phone and Kinoko Lab (the phone already has its keyboard's dictation; speech
there would be the hub streaming audio, a feature of its own).

## 7. Decisions and open questions

Decided (2026-10-14): a key for dictation **and** a mode that listens while kinoko is open;
speaking over kinoko cuts it and becomes a steer at once.

Open:
1. Ctrl+Space for dictation and to mute the listening, or another key?
2. Speech on by default once set up, or off until `/voice on`?
3. The wake word: off (everything said is for kinoko) or on ("kinoko, …")?
