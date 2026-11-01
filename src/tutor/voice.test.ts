import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PCM_BYTES_PER_SECOND, realtimeURL, type SocketLike, VoiceRelay } from "./voice.js";

// The voice relay with both ends replaced: what reaches Meta's socket, and what the browser hears.

function socket() {
  const sent: (string | Uint8Array)[] = [];
  let closed: number | undefined;
  const s: SocketLike & { sent: typeof sent; closed: () => number | undefined } = {
    send: (data) => void sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)),
    close: (code) => void (closed = code ?? 1000),
    sent,
    closed: () => closed,
  };
  return s;
}
const frame = (ms: number) => new Uint8Array((PCM_BYTES_PER_SECOND * ms) / 1000);
const events = (s: ReturnType<typeof socket>) => s.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as { type: string; text?: string });

describe("voice relay", () => {
  it("puts the key in the upstream handshake only, holds audio until the session is ready, and returns the transcript", () => {
    const client = socket();
    const upstream = socket();
    let done: number | undefined;
    const relay = new VoiceRelay(client, upstream, { apiKey: "sk-meta-secret", seconds: 60, onDone: (s) => (done = s) });
    relay.start();
    const handshake = JSON.parse(upstream.sent[0] as string);
    assert.equal(handshake.authorization.accessToken, "sk-meta-secret");
    assert.equal(handshake.audioEncoding, "PCM_16KHZ");
    relay.fromClient(frame(80).buffer);
    relay.fromClient(frame(80).buffer);
    assert.equal(upstream.sent.length, 1, "audio waits for the session");
    relay.fromUpstream(JSON.stringify({ sessionId: "abc" }));
    assert.equal(upstream.sent.length, 3, "then the held audio goes");
    relay.fromClient(JSON.stringify({ type: "end" }));
    assert.deepEqual(JSON.parse(upstream.sent.at(-1) as string), { type: "endStream" });
    relay.fromUpstream(JSON.stringify({ type: "transcript", transcript: "I don't get why", final: false }));
    relay.fromUpstream(JSON.stringify({ type: "transcript", transcript: "I don't get why remote memory is slower.", final: true }));
    assert.deepEqual(events(client), [
      { type: "ready" },
      { type: "transcript", text: "I don't get why", final: false },
      { type: "transcript", text: "I don't get why remote memory is slower.", final: true },
    ]);
    assert.ok(!client.sent.some((m) => typeof m === "string" && m.includes("sk-meta")), "the browser never sees the key");
    assert.equal(client.closed(), 1000);
    assert.equal(upstream.closed(), 1000);
    assert.equal(done, 0.16);
  });

  it("refuses the 61st second but still returns what came before", () => {
    const client = socket();
    const upstream = socket();
    const relay = new VoiceRelay(client, upstream, { apiKey: "k", seconds: 60, onDone: () => {} });
    relay.start();
    relay.fromUpstream(JSON.stringify({ sessionId: "abc" }));
    for (let i = 0; i < 60; i++) relay.fromClient(frame(1000).buffer);
    const audio = () => upstream.sent.filter((m) => typeof m !== "string").length;
    assert.equal(audio(), 60);
    relay.fromClient(frame(80).buffer);
    assert.equal(audio(), 60, "the 61st second is refused");
    assert.deepEqual(events(client).at(-1), { type: "limit", seconds: 60 });
    assert.deepEqual(JSON.parse(upstream.sent.at(-1) as string), { type: "endStream" });
    relay.fromUpstream(JSON.stringify({ type: "transcript", transcript: "a minute of words", final: true }));
    assert.equal(events(client).at(-1)!.text, "a minute of words");
  });

  it("closes both ends once on an upstream error or close, and reports the seconds once", () => {
    const client = socket();
    const upstream = socket();
    const calls: number[] = [];
    const relay = new VoiceRelay(client, upstream, { apiKey: "k", seconds: 60, onDone: (s) => calls.push(s) });
    relay.start();
    relay.fromUpstream(JSON.stringify({ type: "error", message: "bad audio" }));
    relay.closed("upstream", 1008);
    relay.closed("client");
    assert.equal(calls.length, 1);
    assert.match(events(client).at(-1)!.type, /error/);
    assert.equal(client.closed(), 1011);
    assert.throws(() => JSON.parse("x"));
    assert.equal(realtimeURL("https://api.meta.ai/v1/"), "wss://api.meta.ai/v1/asr/realtime");
  });

  it("rejects frames that aren't 16-bit PCM", () => {
    const client = socket();
    const relay = new VoiceRelay(client, socket(), { apiKey: "k", seconds: 60, onDone: () => {} });
    relay.fromClient(new Uint8Array(3).buffer);
    assert.equal(events(client).at(-1)!.type, "error");
  });
});
