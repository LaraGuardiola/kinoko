# The voice on the phone (design)

The app reads kinoko's replies aloud, as the TUI does in voice mode: sentence by sentence while the
model writes, **in the same voice** (the cloned one, Wheatley today), at home or away through
Tailscale. The owner chose how (2026-10-15): the phone asks the hub for each sentence's audio, and
the hub gets it from the computer's text-to-speech backend (option B of three: Android's own TTS
had no cloned voice; the hub speaking every reply by itself would work even with nobody listening).

Hearing only. Talking to kinoko from the phone is the keyboard's dictation today; the microphone to
whisper on the computer would be its own feature. Both sides are built: the hub's (`src/serve/speech.ts`) and the app's (kinoko-android `Voice.kt`, a speaker in each chat's bar). Section 5 is the order.

## 1. The hub: `/v1/speech`

A small file in the core, `src/serve/speech.ts`, behind the hub's usual pairing token:

- `GET /v1/speech` → `{"available": true, "voice": "wheatley", "language": "Spanish"}`, or
  `{"available": false, "why": "no \"tts\" in ~/.kinoko/voice.json"}`. The app shows its button
  only when it is available.
- `POST /v1/speech` with `{"text": "Vale, lo he mirado."}` → the sentence's audio, streamed as it is
  made: raw 16-bit mono PCM, `content-type: audio/pcm; rate=24000` (the rate the backend speaks).

It reads the `"tts"` of `~/.kinoko/voice.json` on each request, the same block the voice extension
uses (docs: the extension's README), so there is one place to set the voice up:

- `http`: the request goes to that `/v1/audio/speech` with the config's voice, language,
  temperature, model and key, `response_format: "pcm"`, and its body streams back to the phone. A
  cloud key never leaves the computer.
- `command`: the program runs with the sentence on its stdin; its stdout streams back.
- A server that answers "unknown voice" (qwentts.cpp forgets cloned voices when it restarts) is
  taught it from `~/.kinoko/voices/` (the `.spk`/`.rvq` latents, else the `.wav`) and asked again,
  once.

That last part and the request itself repeat about forty lines of the extension's `speaker.ts`:
the core cannot import an extension (another repository, copied alone into `~/.kinoko/ext`), and
moving the voice into the core would break "policy in extensions". Forty lines, written down here.

One sentence at a time per device; the backend makes speech about six times faster than it is
heard, so the phone has the next one before it needs it.

## 2. The app

- **A speaker button** in the chat's top bar, beside the menu: off by default, remembered. Off,
  nothing is asked for. Shown only when the hub says speech is available.
- **Sentences**: the reply's `message_delta`s for the agent on screen are cut into sentences the way
  the extension cuts them (sentences.ts, ported to Kotlin with the same tests): code blocks, tables
  and links' addresses left out, markdown's marks dropped. Only replies arriving live: opening a
  chat does not read its history.
- **Playing**: one `AudioTrack` (streaming, 24 kHz mono 16-bit, usage "assistant") for the reply;
  each sentence's bytes are written as they arrive, and the next sentence is asked for when the
  last finished arriving. Headphones and Bluetooth follow Android's routing.
- **Audio focus**: transient, "may duck": music on the phone gets quieter while kinoko talks, and
  comes back.
- **Silence, at once**: the Stop button, sending anything (a prompt, a steer), the run ending
  aborted, leaving the chat or switching agent, the speaker button off. The request in flight is
  cancelled and the track flushed.
- **In the background**: it goes on while the app's process lives (the hub's foreground service
  keeps it); a screen turned off does not stop a sentence.

## 3. What it costs

About 48 KB/s while it talks (24 kHz × 16 bits), fine at home and on 4G. A compressed format would
need an encoder on the computer and a decoder on the phone: not now. The first sound comes when the
first sentence is whole, plus ~0.1 s on the backend, plus the network (tens of milliseconds through
Tailscale).

## 4. Both talking

The phone and a TUI in voice mode follow agents on their own: an agent started from the phone
runs in the hub, not in a terminal, so they rarely speak the same reply. When they do (a terminal's
agent watched from the phone with both on), both speak; the speaker button is the way out.

## 5. Order of work (one branch each)

1. **The hub** (kinoko, `feat/hub-speech`): `src/serve/speech.ts`, the two routes, docs/protocol.md,
   tests with a fake TTS server (streamed through, the voice taught on "unknown voice", a command
   backend, not paired → 401, no config → unavailable).
2. **The app** (kinoko-android, `feat/voice`): the sentence splitter with its tests, the player,
   the button, the stops. Checked on the emulator against this machine's hub, then by the owner on
   the phone (the release APK).

## 6. Decisions (the owner, 2026-10-15)

1. The speaker button sits in each chat's top bar.
2. A phone with it on also reads replies of agents started from a terminal; if that terminal is in
   voice mode too, both speak.
