# Stream B spikes (B0)

Run 2026-11-01 against `https://api.meta.ai/v1` with one Meta key, from Node (scripts in `scripts/spike-b/`,
which read `.env` and never print the key). `GET /v1/models` lists `muse-spark-1.3`, `muse-wonder-1.0`,
`muse-image-1.0`, `muse-voice-transcribe-1.0`, `sam-3.1` (and older Spark versions). No open-weights model.

| # | Try | Result | Decision |
| --- | --- | --- | --- |
| S4 | `muse-image-1.0`, `POST /v1/images/generations`, `{ model, prompt, n: 1 }`: "UMA vs NUMA" labelled diagram | **Pass.** 200 in 18 s (11 s on a second try). Response `{ created, data: [{ b64_json }], output_format, background, usage }`: base64 only, no URL. Default output is **webp, 1920×1280, ~230 KB**. Every label was spelled right and placed sensibly. `size` is accepted but not honoured exactly (1024×576 gave 2048×1152); `output_format: "jpeg"` works but is bigger (~500 KB); `quality` and `output_compression` are rejected (400 "unknown parameter"). Not tried: edit calls (no need in the plan's path) | Build B5 on it. Ask for webp at the default size. There is no way to make the image smaller and no image codec in workerd, so the stored cap is **400 KB** instead of the plan's 150 KB (a Durable Object row holds 2 MB; 400 KB base64 is ~540 KB). Bigger images are refused, not re-encoded |
| S5 | Voice: 2.5 s of 16 kHz mono 16-bit PCM (macOS `say` → `afconvert`) to `wss://api.meta.ai/v1/asr/realtime` | **Pass from Node.** Protocol (from Meta's cookbook, `06_muse_voice/01_voice_api_fundamentals/utils.py`): open the socket, send a JSON handshake `{ mode: "PUSH_TO_TALK", authorization: { accessToken }, audioEncoding: "PCM_16KHZ", model: "muse-voice-transcribe-1.0", partialMode: "CUMULATIVE", emitAudioProgress: false }` (the key goes **in the handshake message**; an Authorization header is ignored), receive `{ sessionId }`, send binary 80 ms PCM frames **paced at real time** (too fast or too slow closes with 1008), then `{ "type": "endStream" }`. Events: `{ type: "transcript", transcript, final }`; partials are cumulative (each replaces the last); `final: true` ends the turn; the server then closes 1000. Handshake took 2.4 s; the final transcript came **231 ms after endStream**, word-perfect | Build B4 on it: the browser paces naturally (it's a microphone), the Worker opens the upstream socket and sends the handshake with the key. workerd check is part of B4 (see `notes-B.md`) |
| S6 | Spark (`muse-spark-1.3`) tool loop through LangChain `bindTools` + `stream`, 3 tools, asked to read a section and two pages at once | **Pass.** Step 1 made **three parallel calls** in one turn with correct arguments (`read_section`, `read_page` ×2); step 2 called `go_to`; step 3 answered from the tool results. Streaming chunks concatenate into a message with `tool_calls` | Full tool list (below), parallel calls allowed, default reasoning effort |
| S7 | `meta-models/muse-spark-open-1026` on Baseten | **Not run**: no Baseten key on this machine, and the model isn't on Meta's endpoint | B7 is built as configuration (a base URL per model) and tested with fakes; the open-weights claim waits for a real run (`JOIN.md` J9) |
| S8 | Streaming `@callable` in the `agents` SDK (0.31) | **Yes.** `@callable({ streaming: true })` methods get a `StreamingResponse` as their first argument (`send`, `end`, `error`); the client passes `{ stream: { onChunk, onDone, onError } }` to `call`. The client's default 30 s call timeout applies only to non-streaming calls | **Stream.** The tutor turn streams step names and reply tokens |
| S9 | Cost and latency | Tutor turn (3 model steps, ~4.5k tokens in, ~1.1k out incl. reasoning): **first token 2.7 s, whole turn 9.7 s**, about $0.01. One image: 11–18 s, $0.01. A personal rewrite (the coach's writer + fact check) was measured at ~63 s in `docs/studio/notes-coach.md` | Inside budget (turn < 8 s to first token; mutation < 60 s is borderline, so it runs in the background and the page shows its progress). A full demo run is well under $1 |

## Decisions

- **Streaming**, not polling, for the tutor turn (S8). Personal rewrites and pictures run in the background
  after the turn and the page polls their status every 2 s while one is running (they outlive the turn).
- **Tools** (S6): `read_section`, `read_page`, `look_at_page`, `go_to`, `open_source`, `ask_me`,
  `rewrite_for_me`, `draw_it`, `interact`, `storyboard`, `suggest_for_everyone`. Parallel calls allowed.
- **Voice path** (S5): browser → Worker route `/agents/voice` (signed in, a course member, within quota) →
  Meta's realtime socket, key added by the Worker. Fallback: the browser's speech recognition, labelled.
- **Images** (S4): webp as returned, refused above 400 KB, cached by prompt hash.
