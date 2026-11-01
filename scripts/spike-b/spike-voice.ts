// S5: Muse Voice Transcribe realtime socket. Never prints the key.
import { readFileSync } from "node:fs";
import { env } from "./env.js";
const wav = readFileSync(process.argv[2]!);
const pcm = wav.subarray(44); // canonical WAV header
const ws = new WebSocket(process.argv[3] ?? "wss://api.meta.ai/v1/asr/realtime");
ws.binaryType = "arraybuffer";
const t0 = Date.now();
let sentAt = 0;
ws.onopen = () => ws.send(JSON.stringify({ mode: "PUSH_TO_TALK", authorization: { accessToken: env("MODEL_API_KEY") }, audioEncoding: "PCM_16KHZ", model: "muse-voice-transcribe-1.0", partialMode: "CUMULATIVE", emitAudioProgress: false }));
ws.onmessage = async (e) => {
  const msg = JSON.parse(String(e.data));
  console.log(`${Date.now() - t0}ms`, JSON.stringify(msg).slice(0, 200));
  if (msg.sessionId) {
    const chunk = 16000 * 2 * 0.08;
    for (let i = 0; i < pcm.length; i += chunk) {
      ws.send(pcm.subarray(i, i + chunk));
      await new Promise((r) => setTimeout(r, 80));
    }
    sentAt = Date.now();
    ws.send(JSON.stringify({ type: "endStream" }));
  }
  if (msg.final) { console.log(`final ${Date.now() - sentAt}ms after endStream`); ws.close(1000); }
};
ws.onclose = (e) => console.log("close", e.code, e.reason);
ws.onerror = (e) => console.log("error", (e as any).message ?? e.type);
