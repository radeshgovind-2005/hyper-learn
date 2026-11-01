import { getAgentByName } from "agents";
import { isBuiltIn, isStudioId } from "../src/app/courses.js";
import { identityFrom } from "../src/auth/identity.js";
import { realtimeURL, VoiceRelay } from "../src/tutor/voice.js";

// The voice route: a signed-in course member's push-to-talk recording, relayed to Meta's realtime
// transcription socket. The course object grants it (membership, one recording at a time, the day's
// minutes) and supplies the key, which stays in the Worker. No anonymous socket reaches Meta.

export const VOICE_PATH = "/agents/voice";

/** Hard stop beyond the granted length: the relay ends a recording at its limit, this catches a stuck one. */
const GRACE_MS = 20_000;

export interface VoiceAdmission {
  /** The Worker's sign-in check: 401 or the request with identity headers. */
  authenticate: (request: Request) => Promise<Request | Response>;
  /** Whether a studio course with this id exists (so no object is created for a made-up id). */
  exists: (id: string) => Promise<boolean>;
}

export async function voice(request: Request, env: Env, admission: VoiceAdmission): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const authenticated = await admission.authenticate(request);
  if (authenticated instanceof Response) return authenticated;
  const identity = identityFrom(authenticated);
  if (!identity) return new Response("Unauthorized", { status: 401 });
  const courseId = new URL(request.url).searchParams.get("course") ?? "";
  if (!(isBuiltIn(courseId) || (isStudioId(courseId) && (await admission.exists(courseId))))) return new Response("Not found", { status: 404 });

  const course = await getAgentByName(env.CourseAgent, courseId);
  let grant: Awaited<ReturnType<typeof course.voiceGrant>>;
  try {
    grant = await course.voiceGrant(identity);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Voice isn't available", { status: 403 });
  }
  const done = (seconds: number) => void course.voiceDone(identity.userId, seconds).catch((error: unknown) => console.error("voiceDone failed:", error));

  const upstreamResponse = await fetch(realtimeURL(grant.meta.baseURL).replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).catch(() => null);
  const upstream = upstreamResponse?.webSocket;
  if (!upstream) {
    done(0);
    return new Response("Transcription isn't reachable just now", { status: 502 });
  }
  upstream.accept();
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();

  const relay = new VoiceRelay(server, upstream, { apiKey: grant.meta.apiKey, seconds: grant.seconds, onDone: done });
  const stop = setTimeout(() => relay.closed("client"), grant.seconds * 1000 + GRACE_MS);
  server.addEventListener("message", (event) => relay.fromClient(event.data as string | ArrayBuffer));
  server.addEventListener("close", () => relay.closed("client"));
  server.addEventListener("error", () => relay.closed("client"));
  upstream.addEventListener("message", (event) => relay.fromUpstream(event.data as string | ArrayBuffer));
  upstream.addEventListener("close", (event) => {
    clearTimeout(stop);
    relay.closed("upstream", event.code);
  });
  upstream.addEventListener("error", () => relay.closed("upstream", 1011));
  relay.start();
  return new Response(null, { status: 101, webSocket: client });
}
