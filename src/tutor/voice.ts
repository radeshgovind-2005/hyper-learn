// Push-to-talk: the browser streams 16 kHz mono 16-bit PCM to the Worker, which relays it to Meta's
// realtime transcription socket (muse-voice-transcribe-1.0) and sends the transcript back. The key goes
// in the upstream handshake, server-side; the browser never sees it. Socket-agnostic, so a test can
// replace both ends. Protocol (Meta's cookbook): handshake JSON → { sessionId } → binary PCM frames →
// { type: "endStream" } → { type: "transcript", transcript, final } events, cumulative; final ends it.

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
/** 16 kHz × 2 bytes per sample, mono. */
export const PCM_BYTES_PER_SECOND = 32_000;
/** Audio held while the upstream handshake completes (about 2.5 s); more than this and the recording is refused. */
const MAX_BUFFERED_BYTES = 5 * PCM_BYTES_PER_SECOND;
/** Largest frame accepted from a browser (it sends ~80 ms frames, 2.5 KB). */
const MAX_FRAME_BYTES = 64 * 1024;

export interface SocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** What the browser hears from the relay. */
export type VoiceEvent = { type: "ready" } | { type: "transcript"; text: string; final: boolean } | { type: "error"; message: string } | { type: "limit"; seconds: number };

export interface RelayOptions {
  /** The upstream credential (the course's Meta key). Never sent to the client. */
  apiKey: string;
  /** How long this recording may last. */
  seconds: number;
  /** Called once, when the recording ends for any reason, with the seconds of audio received. */
  onDone: (seconds: number) => void;
}

/** The realtime socket's address from the API's base URL (https://api.meta.ai/v1 → wss://api.meta.ai/v1/asr/realtime). */
export function realtimeURL(baseURL: string): string {
  return `${baseURL.replace(/\/$/, "").replace(/^http/, "ws")}/asr/realtime`;
}

export class VoiceRelay {
  private ready = false;
  private finished = false;
  private bytes = 0;
  private limited = false;
  private readonly buffered: Uint8Array[] = [];
  private bufferedBytes = 0;

  constructor(
    private readonly client: SocketLike,
    private readonly upstream: SocketLike,
    private readonly options: RelayOptions,
  ) {}

  /** Opens the upstream session. Call once the upstream socket is open. */
  start() {
    this.upstream.send(
      JSON.stringify({
        mode: "PUSH_TO_TALK",
        authorization: { accessToken: this.options.apiKey },
        audioEncoding: "PCM_16KHZ",
        model: VOICE_MODEL,
        partialMode: "CUMULATIVE",
        emitAudioProgress: false,
      }),
    );
  }

  private tell(event: VoiceEvent) {
    if (!this.finished) this.client.send(JSON.stringify(event));
  }

  /** A message from the browser: a binary PCM frame, or { "type": "end" } when the learner lets go of the mic. */
  fromClient(data: string | ArrayBuffer | Uint8Array) {
    if (this.finished) return;
    if (typeof data === "string") {
      let message: { type?: unknown } | null = null;
      try {
        message = JSON.parse(data) as { type?: unknown };
      } catch {
        // ignored: only "end" means anything
      }
      if (message?.type === "end") this.endStream();
      return;
    }
    const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (frame.byteLength > MAX_FRAME_BYTES || frame.byteLength % 2 !== 0) return this.fail("That audio frame isn't 16-bit PCM");
    if (this.limited) return;
    // The frame that would pass the limit is refused, and the transcript of what came before still arrives.
    if (this.bytes + frame.byteLength > this.options.seconds * PCM_BYTES_PER_SECOND) {
      this.limited = true;
      this.tell({ type: "limit", seconds: this.options.seconds });
      this.endStream();
      return;
    }
    this.bytes += frame.byteLength;
    if (this.ready) {
      this.upstream.send(frame);
      return;
    }
    this.bufferedBytes += frame.byteLength;
    if (this.bufferedBytes > MAX_BUFFERED_BYTES) return this.fail("Transcription took too long to start");
    this.buffered.push(frame);
  }

  private ended = false;
  private endStream() {
    if (this.ended) return;
    this.ended = true;
    // Before the session is ready the end waits for the buffered audio to go first (see fromUpstream).
    if (this.ready) this.upstream.send(JSON.stringify({ type: "endStream" }));
  }

  /** A message from Meta's socket. */
  fromUpstream(data: string | ArrayBuffer) {
    if (this.finished || typeof data !== "string") return;
    let event: { type?: string; sessionId?: string; transcript?: string; final?: boolean; message?: string };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }
    if (!this.ready && event.sessionId) {
      this.ready = true;
      for (const frame of this.buffered.splice(0)) this.upstream.send(frame);
      this.bufferedBytes = 0;
      this.tell({ type: "ready" });
      if (this.ended) this.upstream.send(JSON.stringify({ type: "endStream" }));
      return;
    }
    if (event.type === "error") return this.fail(`Transcription failed: ${String(event.message ?? "no reason given").slice(0, 200)}`);
    if (event.type === "transcript" && typeof event.transcript === "string") {
      this.tell({ type: "transcript", text: event.transcript.slice(0, 2_000), final: event.final === true });
      if (event.final === true) this.finish(1000, "done");
    }
  }

  /** Either side closed or errored. */
  closed(side: "client" | "upstream", code?: number) {
    if (this.finished) return;
    if (side === "upstream" && code !== 1000) this.tell({ type: "error", message: code === 1013 ? "Transcription is busy; try again" : "Transcription stopped unexpectedly" });
    this.finish(1000, "closed");
  }

  private fail(message: string) {
    this.tell({ type: "error", message });
    this.finish(1011, "error");
  }

  private finish(code: number, reason: string) {
    if (this.finished) return;
    this.finished = true;
    for (const socket of [this.client, this.upstream]) {
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.options.onDone(this.bytes / PCM_BYTES_PER_SECOND);
  }
}
