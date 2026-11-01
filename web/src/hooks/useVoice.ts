import { useCallback, useEffect, useRef, useState } from "react";

// Push-to-talk. Meta's transcription through the Worker (/agents/voice): the microphone is captured at
// 16 kHz, turned into 16-bit PCM in an AudioWorklet and sent in ~80 ms frames; the transcript comes
// back as it forms. If that path can't open, the browser's own speech recognition is used instead, and
// the dock says so. The transcript fills the text box; nothing is sent until the learner presses send.

export type VoiceState = "idle" | "connecting" | "listening" | "finishing" | "error";
export type VoiceEngine = "meta" | "browser";

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1_280; // 80 ms

// Float samples in, 16-bit PCM frames out (posted to the page, which sends them on the socket).
const WORKLET = `
class PcmFrames extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${FRAME_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-frames", PcmFrames);
`;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

function browserRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice({ courseId, token, onText }: { courseId: string; token: () => Promise<string>; onText: (text: string, final: boolean) => void }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [engine, setEngine] = useState<VoiceEngine>("meta");
  const [error, setError] = useState<string | null>(null);
  const parts = useRef<{ socket?: WebSocket; context?: AudioContext; stream?: MediaStream; recognition?: SpeechRecognitionLike; limit?: ReturnType<typeof setTimeout> }>({});
  const textRef = useRef(onText);
  textRef.current = onText;

  const release = useCallback(() => {
    const p = parts.current;
    if (p.limit) clearTimeout(p.limit);
    p.stream?.getTracks().forEach((t) => t.stop());
    void p.context?.close().catch(() => {});
    parts.current = { ...(p.socket && { socket: p.socket }) };
  }, []);

  useEffect(
    () => () => {
      release();
      parts.current.socket?.close();
      parts.current.recognition?.stop();
    },
    [release],
  );

  const startBrowser = useCallback(() => {
    const Recognition = browserRecognition();
    if (!Recognition) {
      setState("error");
      setError("Voice isn't available here; type instead");
      return;
    }
    setEngine("browser");
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const text = Array.from(event.results).map((r) => r[0]?.transcript ?? "").join("");
      const final = Array.from(event.results).every((r) => r.isFinal);
      textRef.current(text, final);
    };
    recognition.onend = () => setState("idle");
    recognition.onerror = (event) => {
      setState("error");
      setError(event.error === "not-allowed" ? "The microphone is blocked for this site" : "Browser speech stopped");
    };
    parts.current.recognition = recognition;
    recognition.start();
    setState("listening");
  }, []);

  const start = useCallback(async () => {
    if (state === "connecting" || state === "listening" || state === "finishing") return;
    setError(null);
    if (engine === "browser") return startBrowser();
    setState("connecting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setState("error");
      setError("The microphone is blocked for this site");
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/agents/voice?course=${encodeURIComponent(courseId)}&token=${encodeURIComponent(await token())}`);
    socket.binaryType = "arraybuffer";
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    parts.current = { socket, context, stream };
    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as { type: string; text?: string; final?: boolean; message?: string; seconds?: number };
      if (event.type === "ready") setState((s) => (s === "connecting" ? "listening" : s));
      else if (event.type === "transcript") textRef.current(event.text ?? "", event.final === true);
      else if (event.type === "limit") setError(`Stopped at ${event.seconds} s`);
      else if (event.type === "error") setError(event.message ?? "Voice stopped");
    };
    socket.onclose = () => {
      release();
      parts.current = {};
      if (!opened) {
        // The Meta path refused or isn't reachable (no key, quota, offline): fall back to the browser's own.
        startBrowser();
        return;
      }
      setState((s) => (s === "error" ? s : "idle"));
    };
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(context, "pcm-frames");
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
      };
      context.createMediaStreamSource(stream).connect(node);
      // The server refuses the 61st second; stop the microphone just before.
      parts.current.limit = setTimeout(() => stop(), 59_500);
    } catch {
      socket.close();
      setState("error");
      setError("Couldn't start recording in this browser");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, engine, courseId, token, startBrowser, release]);

  const stop = useCallback(() => {
    const p = parts.current;
    if (p.recognition) {
      p.recognition.stop();
      return;
    }
    release();
    if (p.socket && p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(JSON.stringify({ type: "end" }));
      setState("finishing");
    } else if (p.socket) {
      p.socket.close();
      setState("idle");
    }
  }, [release]);

  return { state, engine, error, start, stop };
}
