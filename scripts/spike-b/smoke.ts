// Stream B smoke test against `wrangler dev --port 8799 --var AUTH_DEV_BYPASS:true` (local only).
//   npx tsx scripts/spike-b/smoke.ts setup      creates, builds and publishes a studio course with the real model
//   npx tsx scripts/spike-b/smoke.ts tutor      runs tutor turns, an ask, a rewrite, a diagram
//   npx tsx scripts/spike-b/smoke.ts voice <wav>
// The course id is kept in scripts/spike-b/.smoke-course (gitignored by the scratch rule below). Never prints the key.
import { readFileSync, writeFileSync } from "node:fs";
import { AgentClient } from "agents/client";
import { env } from "./env.js";

const HOST = process.env.SMOKE_HOST ?? "localhost:8799";
const ID_FILE = new URL("./.smoke-course", import.meta.url);
const OWNER = "smoke_owner";
const LEARNER = process.argv[3] && process.argv[2] !== "voice" ? process.argv[3] : "smoke_learner";

function client(agent: string, name: string, user: string, role = "learner") {
  return new AgentClient({ agent, name, host: HOST, query: { devUser: user, devRole: role } });
}
async function ready(c: AgentClient) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    c.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
    c.addEventListener("error", () => (clearTimeout(timer), reject(new Error("socket error"))), { once: true });
  });
  // The identify frame arrives right after open.
  await new Promise((r) => setTimeout(r, 300));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An original three-page note on UMA and NUMA, written for this test (no third-party material).
const PAGES = [
  "Shared-memory multiprocessors. In a uniform memory access (UMA) machine every processor reaches all of main memory through one shared bus or switch, so a load takes about the same time whichever processor issues it and whichever address it touches. UMA is simple to program, but the shared bus becomes a bottleneck as processors are added: every memory request from every core competes for the same path.",
  "Non-uniform memory access (NUMA). A NUMA machine is built from nodes. Each node has its own processors and its own local memory with its own memory controller. A processor can still address all memory, but reaching memory attached to another node means crossing the interconnect between nodes. Local access is fast; remote access is slower, typically 1.5 to 2 times the latency of a local access, because the request and the data travel over the interconnect and through the other node's controller.",
  "Why placement matters. Because remote memory is slower, where data lives changes performance. An operating system with a first-touch policy puts a page in the memory of the node whose processor first writes it. A thread that keeps running on the same node then finds its data local. If the scheduler moves the thread to another node, or one thread initialises data that threads on other nodes use, most accesses become remote and the program slows down even though nothing in its code changed.",
];

async function setup() {
  const dir = client("directory-agent", "main", OWNER);
  await ready(dir);
  const course = await dir.call<{ id: string }>("createCourse", [{ title: "Memory in multiprocessors (smoke)", description: "UMA and NUMA", audience: "intermediate" }]);
  writeFileSync(ID_FILE, course.id);
  console.log("course", course.id);
  dir.close();
  const owner = client("course-agent", course.id, OWNER);
  await ready(owner);
  await owner.call("addSource", [{ name: "numa-notes.pdf", pages: PAGES }]);
  await owner.call("setModelKey", [env("MODEL_API_KEY"), "muse-spark-1.3"]);
  await owner.call("build", []);
  const t0 = Date.now();
  for (;;) {
    await sleep(5_000);
    const overview = await owner.call<{ build: { status: string; steps: { title: string }[]; problems?: string[] } | null }>("overview", []);
    const b = overview.build;
    console.log(`${Math.round((Date.now() - t0) / 1000)}s`, b?.status, b?.steps.at(-1)?.title ?? "");
    if (b?.status === "done") break;
    if (b?.status === "failed") throw new Error(`build failed: ${b.problems?.join("; ")}`);
  }
  console.log(await owner.call("publish", []));
  for (const s of await owner.call<{ id: string }[]>("sources", [])) await owner.call("setSourceShared", [s.id, true]);
  owner.close();
}

async function turn(c: AgentClient, input: Record<string, unknown>) {
  const t0 = Date.now();
  let first = 0;
  const events: string[] = [];
  const result = await new Promise<{ result: { reply: string; actions: unknown[]; blocks: { id: string; kind: string; status: string }[]; ask?: { id: string; prompt: string; options: string[] }; model_calls: number; stopped?: string } }>((resolve, reject) => {
    void c.call("tutorTurn", [input], {
      stream: {
        onChunk: (chunk) => {
          if (!first) first = Date.now() - t0;
          const e = chunk as { type: string; label?: string; delta?: string };
          if (e.type === "step") events.push(`[${e.label}]`);
        },
        onDone: (final) => resolve(final as never),
        onError: (error) => reject(new Error(error)),
      },
    });
  });
  const r = result.result;
  console.log(`\n> ${String(input.text)}\n  first event ${first} ms, done ${Date.now() - t0} ms, ${r.model_calls} model calls ${r.stopped ? `(stopped: ${r.stopped})` : ""}`);
  console.log(`  steps: ${events.join(" ")}`);
  console.log(`  reply: ${r.reply}`);
  if (r.actions.length) console.log(`  actions: ${JSON.stringify(r.actions)}`);
  if (r.blocks.length) console.log(`  blocks: ${JSON.stringify(r.blocks)}`);
  if (r.ask) console.log(`  ask: ${r.ask.prompt} | ${r.ask.options.join(" | ")}`);
  return r;
}

async function waitBlocks(c: AgentClient, lesson: string) {
  const t0 = Date.now();
  for (;;) {
    const blocks = await c.call<{ id: string; kind: string; status: string; pieces: unknown[]; provenance: unknown; problems: string[]; approach: string | null }[]>("personalBlocks", [lesson]);
    if (!blocks.some((b) => b.status === "running") || Date.now() - t0 > 240_000) {
      for (const b of blocks) console.log(`  block ${b.kind} ${b.status} ${b.approach ?? ""} after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(b.provenance)} ${b.problems.join(" | ")} pieces=${JSON.stringify(b.pieces).slice(0, 400)}`);
      return blocks;
    }
    await sleep(3_000);
  }
}

/** Owner makes an invite; the learner joins through the directory (studio courses are for members). */
async function join(id: string, who: string) {
  const owner = client("course-agent", id, OWNER);
  await ready(owner);
  const { token } = await owner.call<{ token: string }>("rotateInvite", []);
  owner.close();
  const dir = client("directory-agent", "main", who);
  await ready(dir);
  await dir.call("join", [id, token]).catch((e: unknown) => console.log("join:", e instanceof Error ? e.message : e));
  dir.close();
}

async function tutor() {
  const id = readFileSync(ID_FILE, "utf8").trim();
  await join(id, LEARNER);
  const c = client("course-agent", id, LEARNER);
  await ready(c);
  const snapshot = await c.call<{ lessons: { id: string; title: string; sections: { id: string; title: string }[] }[] }>("snapshot", []);
  for (const l of snapshot.lessons) console.log(l.id, "|", l.sections.map((s) => s.id).join(", "));
  const lesson = snapshot.lessons.find((l) => /numa|remote|non-uniform/i.test(JSON.stringify(l))) ?? snapshot.lessons[0]!;
  const section = lesson.sections.find((s) => /remote|numa|non-uniform/i.test(s.title)) ?? lesson.sections[0]!;
  console.log("info", JSON.stringify(await c.call("tutorInfo", [lesson.id])).slice(0, 200));
  const first = await turn(c, { lesson: lesson.id, section: section.id, text: "I don't get why remote memory is slower" });
  if (first.ask) {
    const answer = await c.call("answerAsk", [first.ask.id, first.ask.options.length - 1]);
    console.log("  answered:", JSON.stringify(answer));
    const second = await turn(c, { lesson: lesson.id, section: section.id, text: `I answered: "${first.ask.options.at(-1)}"` });
    void second;
  }
  await waitBlocks(c, lesson.id);
  await turn(c, { lesson: lesson.id, section: section.id, text: "Can you draw local versus remote memory access for me?" });
  await waitBlocks(c, lesson.id);
  c.close();
}

async function voice(wavPath: string) {
  const id = readFileSync(ID_FILE, "utf8").trim();
  await join(id, LEARNER);
  const pcm = readFileSync(wavPath).subarray(44);
  const url = `ws://${HOST}/agents/voice?course=${id}&devUser=${LEARNER}&devRole=learner`;
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    const req = request(`http://${HOST}/agents/voice?course=${id}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.on("upgrade", (res) => resolve(res.statusCode ?? 101));
    req.end();
  });
  console.log("without a token:", status);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const t0 = Date.now();
  let endAt = 0;
  ws.onopen = async () => {
    console.log(`open ${Date.now() - t0} ms`);
    const chunk = 16000 * 2 * 0.08;
    for (let i = 0; i < pcm.length; i += chunk) {
      const slice = pcm.subarray(i, i + chunk);
      ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
      await sleep(80);
    }
    endAt = Date.now();
    ws.send(JSON.stringify({ type: "end" }));
  };
  ws.onmessage = (e) => console.log(`${Date.now() - t0} ms`, String(e.data), endAt ? `(${Date.now() - endAt} ms after end)` : "");
  await new Promise<void>((resolve) => {
    ws.onclose = (e) => {
      console.log("closed", e.code, e.reason);
      resolve();
    };
  });
}

/** Three learners: "Explain differently" on one section, then "Quiz me on this", answered right: the bandit's counts and a promotion. */
async function promote() {
  const id = readFileSync(ID_FILE, "utf8").trim();
  for (const who of ["smoke_q1", "smoke_q2", "smoke_q3"]) {
    await join(id, who);
    const c = client("course-agent", id, who);
    await ready(c);
    const snapshot = await c.call<{ lessons: { id: string; sections: { id: string; title: string }[]; quiz: { prompt: string; options?: { text: string; correct: boolean }[] }[] }[] }>("snapshot", []);
    const lesson = snapshot.lessons[1]!;
    const section = lesson.sections[1]!;
    await turn(c, { lesson: lesson.id, section: section.id, text: "Explain this section differently.", shortcut: "explain" });
    await waitBlocks(c, lesson.id);
    const quiz = await turn(c, { lesson: lesson.id, section: section.id, text: "Quiz me on this section.", shortcut: "quiz" });
    if (!quiz.ask) {
      console.log("  (no question asked)");
      continue;
    }
    // A smoke test may look the key up in the learner's snapshot (stream A removes it from there); checks fall back to option 0.
    const item = snapshot.lessons.flatMap((l) => l.quiz).find((q) => q.prompt === quiz.ask!.prompt);
    const right = item?.options?.findIndex((o) => o.correct) ?? -1;
    console.log("  answer:", JSON.stringify(await c.call("answerAsk", [quiz.ask.id, right >= 0 ? right : 0])));
    c.close();
  }
  const owner = client("course-agent", id, OWNER);
  await ready(owner);
  for (const r of await owner.call<{ label: string; learners: number; fixed: number; repaired: number; promote: unknown }[]>("coachInsights", [])) console.log(`insight: ${r.label.slice(0, 60)} · ${r.learners} learners · fixed ${r.fixed}/${r.repaired} · promote ${JSON.stringify(r.promote)}`);
  owner.close();
}

const stage = process.argv[2];
if (stage === "setup") await setup();
else if (stage === "tutor") await tutor();
else if (stage === "voice") await voice(process.argv[3]!);
else if (stage === "promote") await promote();
else console.log("stage: setup | tutor | voice <wav>");
process.exit(0);
