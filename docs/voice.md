# Voice: talking with kinoko (design)

"The dream of talking with robots" (the owner, 2026-10-14). Three features for the TUI:

- **Listening (STT)**: Ctrl+Space turns voice mode on; what you say to kinoko by name becomes a
  prompt. Pluggable backends.
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

**Listening: whisper.cpp** on the CPU. large-v3-turbo q5_0 transcribed 8 minutes of Spain-Spanish
speech in 2 m 43 s with clean punctuation; for short phrases the small model is the fast one
(section 4b has the numbers). Parakeet TDT v3 is an alternative if that is not enough.

Others looked at: Chatterbox Multilingual v3 (MIT, 23 languages, the "beats ElevenLabs" one, needs
the GPU, no CPU numbers), Voxtral TTS (non-commercial, cloning only through Mistral's API),
Kokoro and Piper (no cloning; Kokoro's Spanish is weak).

## 2. Shape: one extension, three small hooks in the core

Policy lives in extensions, so the voice is **one extension, `voice`, in kinoko-extensions**: it
records, calls the backends, splits the text, plays the audio. kinoko does not start or manage the
speech servers (they are services, like llama-server); the extension's README says how to run them.

The core grows four hooks, each small and useful to other extensions:

1. **`k.on("agent_event", (event) => …)`**: every AgentEvent the TUI sees (src/agent-events.ts),
   read-only. The voice needs `message_delta` (the reply as it streams), `run_start` and `run_end`.
   One general hook instead of a new event per need.
2. **`k.on("interrupt", () => …)`**: the user asked for quiet: Esc or Ctrl-C, **also while idle**
   (today Esc does nothing then). The first Esc after a run stops the voice.
3. **`k.registerKey(key, description, handler)`**, TUI only: the handler gets `status(text |
   undefined)`, a word on the rule above the editor, right side ("● listening"). Listed in /help. Core
   keys cannot be taken.
4. **`k.send(text, { as: "prompt" | "steer_now" })`**: the extension speaking for the user, exactly
   as if typed and sent (section 4b).

Zero runtime dependencies: `fetch`, `Bun.spawn`, PipeWire's `pw-record` and `pw-play`.

## 3. The key: Ctrl+Space

Everything voice starts **off** when kinoko opens. **Ctrl+Space turns voice mode on**: kinoko
listens for its name (section 4b) and reads its replies aloud (section 4). Ctrl+Space again turns
it all off at once: the microphone closes and the voice stops. `/voice` does the same by command
and picks the voice. A word on the rule above the editor, right side, says so, steady: "● listening", "● kinoko
hears you" (no "transcribing": every sound in the room is transcribed to look for the name, and it
would flicker).

Terminals do not report key releases, so it is a toggle, not hold-to-talk.

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

On while voice mode is (Ctrl+Space). **The wake word is "kinoko"**: only what starts with it is
for kinoko ("Kinoko, mira por qué falla el test"; "Oye kinoko, para"). The word itself is taken
out before the text reaches the model.

- **The microphone streams** (`pw-record`, 16 kHz mono raw PCM on stdout) into the extension.
- **Voice activity**: a small detector in the extension (energy over a noise floor that adapts,
  with a short hangover; plain TypeScript, tested on recorded PCM) finds where speech starts and ends.
- **Barge-in**: 300 ms of speech while kinoko talks **lowers its voice at once** (before anything is
  transcribed); when the transcript starts with "kinoko", it is **cut** (the same path as Esc)
  and the rest is the steer; when it does not (someone else in the room), the voice comes back up.
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
- **The room**: an open microphone hears everyone (the TV, a call): that is what the wake word is
  for, and Ctrl+Space closes the microphone at once.
- **Hearing its name**: whisper may write it "Quinoco" or "Kinokoko"; the first two words are
  matched loosely (qu/c → k, one letter off), and whisper is primed with the word (`--prompt
  "Kinoko"`), which in the spike made even the small model spell it right every time.

**Latency**: the end of speech ~0.7 s, then the transcription. Measured in the spike on clean,
synthesized phrases (a real microphone in a room still to test), CPU, 8 threads:

| whisper.cpp model | 1–3 s phrase | Wrote "Kinoko" |
|---|---|---|
| large-v3-turbo q5_0, default window (always 30 s of audio) | **~9.5 s**: unusable | yes |
| large-v3-turbo q5_0, window sized to the clip (`-ac`) | 0.85–1.3 s | yes |
| **small q5_1, window sized, primed with "Kinoko"** | **0.2–0.35 s** | **yes, 4 of 4** |
| small q5_1, not primed | 0.5 s | "Quinoco" |

So the default is **small**, with the window sized to each utterance and the prompt primed;
large-v3-turbo stays one config line away when accuracy matters more than speed.

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
2. **Hearing** (kinoko-extensions, `feat/voice-hear`): the microphone, voice activity, the wake
   word, both backend kinds, `voice.json`, Ctrl+Space; utterances become prompts. Measured on
   Spanish phrases spoken into this laptop.
3. **Speech** (kinoko-extensions, `feat/voice-speak`): the sentence splitter (tested hard), the
   queue, playback, cutting, voices, `/voice`. Checked by ear by the owner. Built 2026-10-14: one
   pw-play per reply fed sentence after sentence (synthesis ~5× faster than speech, so the next is
   ready before the last ends); the clone taught to the server as latents encoded ahead on the CPU
   (`qwen-codec`: encoding the clip on the GPU beside the LLM ran out of memory and crashed the
   server); its own voice heard back is dropped (3+ words, mostly its recent words). MiniCPM
   beside it: `NCMOE=38` (5.0 GB; 726 tok/s prompt, 37.9 generation, vs ~850 / ~42 at 34).
4. **This machine**: whisper.cpp and qwentts.cpp built (CUDA) under `~/Projects`, models in place,
   `~/bin/tts-serve.sh` beside `lfm-serve.sh`/`minicpm-serve.sh` (their NCMOE for it in their headers),
   the Wheatley voice in `~/.kinoko/voices`. Echo cancelling (done 2026-10-14): PipeWire's WebRTC AEC
   as its own pipewire process (`~/.config/pipewire/kinoko-echo-cancel.conf`, user service
   `kinoko-echo-cancel`), `monitor.mode` (the reference is whatever the speakers play), source
   `kinoko-aec-source`, not the default microphone; voice.json records from it. Measured: the
   speakers' speech goes from about -50 dB to -81 dB after a second or two of settling; music
   playing in the room is gone too; kinoko talking a whole reply with the microphone open: the
   plain microphone transcribed it (and its own name: it would have answered itself), the
   cancelled one not a word of it.
5. **Conversation**: utterances as steers sent now (done with step 2's fixes), and barge-in: kinoko stops
   talking when what you say starts with "kinoko". Lowering its volume the moment anyone speaks was
   built and taken out at the owner's request: other people talking in the room made it dip all the
   time. Tuned by voice with the owner.

Not in this work: the phone and Kinoko Lab (the phone already has its keyboard's dictation; speech
there would be the hub streaming audio, a feature of its own).

## 7. Decisions (the owner, 2026-10-14)

1. **Ctrl+Space** turns voice mode on and off; everything voice is **off** when kinoko opens.
2. A mode that listens while kinoko is open; speaking over kinoko cuts it and becomes a steer at once.
3. **The wake word is "kinoko"** ("not something I say by mistake").
4. No separate "dictate into the editor" key: voice mode is the one way in. (Easy to add later.)
