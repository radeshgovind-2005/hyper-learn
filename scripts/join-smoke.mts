// The join's acceptance script (docs/hackathon/JOIN.md §7) against local workerd, as far as it runs without a
// browser. Local only: `wrangler dev --port 8799 --persist-to <scratch> --var AUTH_DEV_BYPASS:true
// --var KEY_ENCRYPTION_SECRET:<random>`. Reads MODEL_API_KEY from .env and never prints it.
//   npx tsx scripts/join-smoke.mts setup <pdf> <pages dir>   upload text, original and page pictures; build; publish
//   npx tsx scripts/join-smoke.mts content                   what the build made, and what a learner may fetch
//   npx tsx scripts/join-smoke.mts tutor                     ask → diagnostic → rewrite, diagram, widget
//   npx tsx scripts/join-smoke.mts voice <16 kHz mono wav>   push-to-talk through /agents/voice
//   npx tsx scripts/join-smoke.mts promote                   three learners fixed by one approach → promote
//   npx tsx scripts/join-smoke.mts integrity                 no answer key in what learners get
// The browser's job (pdf.js text, page pictures) is done by the caller: <pages dir> holds p<n>.txt and img-<n>.jpg.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { AgentClient } from "agents/client";
import { env } from "./spike-b/env.js";

const HOST = process.env.SMOKE_HOST ?? "localhost:8799";
const ID_FILE = process.env.SMOKE_ID_FILE ?? ".join-smoke-course";
const OWNER = "join_owner";
const MODEL = process.env.SMOKE_MODEL ?? "muse-spark-1.3";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function client(agent: string, name: string, user: string) {
  return new AgentClient({ agent, name, host: HOST, query: { devUser: user, devRole: "learner" } });
}
async function open(agent: string, name: string, user: string) {
  const c = client(agent, name, user);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
    c.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
    c.addEventListener("error", () => (clearTimeout(timer), reject(new Error("socket error"))), { once: true });
  });
  await sleep(300); // the identify frame arrives right after open
  return c;
}
const courseId = () => readFileSync(ID_FILE, "utf8").trim();

type Block = { id: string; kind: string; markdown?: string; cites?: { source: string; page: number }[]; provenance?: { pages: unknown[]; fact_check: string }; quotes?: unknown[] };
type Snapshot = { version: string; lessons: { id: string; title: string; sections: { id: string; title: string; blocks: Block[] }[]; quiz: { id: string; prompt: string; type: string; options?: { text: string; correct?: boolean }[] }[] }[] };

async function setup(pdf: string, dir: string) {
  const d = await open("directory-agent", "main", OWNER);
  const course = await d.call<{ id: string }>("createCourse", [{ title: "Scaling in parallel computing (join smoke)", description: "Speedup, Amdahl, 2D partitioning", audience: "intermediate" }]);
  d.close();
  writeFileSync(ID_FILE, course.id);
  console.log("course", course.id);
  const o = await open("course-agent", course.id, OWNER);
  const texts = readdirSync(dir).filter((f) => /^p\d+\.txt$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).map((f) => readFileSync(`${dir}/${f}`, "utf8").trim() || "(no text)");
  const source = await o.call<{ id: string }>("addSource", [{ name: pdf.split("/").at(-1), pages: texts }]);
  const id = source.id ?? (await o.call<{ id: string }[]>("sources", [])).at(-1)!.id;
  // The original, in 512 KB chunks, as web/src/files.ts sends it.
  const bytes = readFileSync(pdf);
  const size = 512 * 1024;
  const chunks = Math.ceil(bytes.length / size);
  for (let seq = 0; seq < chunks; seq++) await o.call("addSourceFileChunk", [id, seq, bytes.subarray(seq * size, (seq + 1) * size).toString("base64"), chunks]);
  let pictured = 0;
  for (let n = 1; n <= texts.length; n++) {
    try {
      const jpeg = readFileSync(`${dir}/img-${n}.jpg`).toString("base64");
      await o.call("addPageImage", [id, n, jpeg, "image/jpeg"]);
      pictured++;
    } catch (e) {
      console.log(`page ${n}: no picture (${e instanceof Error ? e.message : e})`);
    }
  }
  console.log(`source ${id}: ${texts.length} pages, original ${bytes.length} bytes in ${chunks} chunk(s), ${pictured} page pictures`);
  await o.call("setModelKey", [env("MODEL_API_KEY"), MODEL]);
  const t0 = Date.now();
  await o.call("build", []);
  let shown = 0;
  for (;;) {
    await sleep(5_000);
    const b = (await o.call<{ build: { status: string; steps: { stage: string; title: string; status: string; detail?: string }[]; problems?: string[]; warnings?: string[]; model_calls?: number } | null }>("overview", [])).build;
    for (const s of b?.steps.slice(shown) ?? []) console.log(`  ${t(t0)} [${s.stage}] ${s.status} ${s.title}${s.detail ? ` — ${s.detail.slice(0, 160)}` : ""}`);
    shown = b?.steps.length ?? shown;
    if (b?.status === "done" || b?.status === "failed") {
      console.log(`build ${b.status} in ${t(t0)}, ${b.model_calls ?? "?"} model calls`, b.problems?.join("; ") ?? "", (b.warnings ?? []).slice(0, 5).join(" | "));
      if (b.status === "failed") process.exit(1);
      break;
    }
  }
  console.log("publish:", JSON.stringify(await o.call("publish", [])).slice(0, 200));
  o.close();
}

/** Owner makes an invite; the learner joins through the directory. */
async function join(id: string, who: string) {
  const o = await open("course-agent", id, OWNER);
  const { token } = await o.call<{ token: string }>("rotateInvite", []);
  o.close();
  const d = await open("directory-agent", "main", who);
  await d.call("join", [id, token]).catch((e: unknown) => console.log("join:", e instanceof Error ? e.message : e));
  d.close();
}

async function content() {
  const id = courseId();
  const o = await open("course-agent", id, OWNER);
  const s = await o.call<Snapshot>("snapshot", []);
  o.close();
  const blocks = s.lessons.flatMap((l) => l.sections.flatMap((x) => x.blocks));
  const text = blocks.filter((b) => typeof b.markdown === "string");
  const figs = [...new Set(text.flatMap((b) => [...b.markdown!.matchAll(/\]\(fig:([^)]+)\)/g)].map((m) => m[1]!)))];
  const verdicts = text.reduce<Record<string, number>>((n, b) => ((n[b.provenance?.fact_check ?? "none"] = (n[b.provenance?.fact_check ?? "none"] ?? 0) + 1), n), {});
  console.log(`${s.version}: ${s.lessons.length} lessons, ${s.lessons.reduce((n, l) => n + l.sections.length, 0)} sections, ${s.lessons.reduce((n, l) => n + l.quiz.length, 0)} quiz items`);
  console.log(`text blocks ${text.length}: with a figure ${text.filter((b) => /\]\(fig:/.test(b.markdown!)).length} (${figs.length} distinct), tables ${text.filter((b) => /^\s*\|.*\|\s*$/m.test(b.markdown!)).length}, formulas ${text.filter((b) => /\$/.test(b.markdown!)).length}, quotes ${text.filter((b) => b.quotes?.length).length}, provenance ${JSON.stringify(verdicts)}`);
  for (const l of s.lessons) console.log(`  #${l.sections[0]?.id ?? l.id}  ${l.title} | ${l.sections.map((x) => x.title).join(" · ")}`);
  const sample = text.find((b) => /\]\(fig:/.test(b.markdown!)) ?? text[0];
  if (sample) console.log("a block:", JSON.stringify({ markdown: sample.markdown!.slice(0, 300), cites: sample.cites, provenance: sample.provenance }));
  const formula = text.find((b) => /\$/.test(b.markdown!));
  if (formula) console.log("a formula block:", formula.markdown!.slice(0, 200));

  await join(id, "join_learner");
  const c = await open("course-agent", id, "join_learner");
  const cited = await c.call<{ id: string; name: string; pages: number; file?: unknown }[]>("citedSources", []);
  console.log("learner citedSources:", JSON.stringify(cited));
  if (figs[0]) console.log(`learner figure(${figs[0]}):`, JSON.stringify(await c.call("figure", [figs[0]])).slice(0, 200));
  const page = sample?.cites?.[0];
  if (page) {
    const img = await c.call<{ mime: string; base64: string } | null>("pageImage", [page.source, page.page]);
    console.log(`learner pageImage(${page.source}, ${page.page}):`, img ? `${img.mime}, ${img.base64.length} base64 chars` : "null");
    const chunk = await c.call<{ total: number; base64: string }>("sourceFileChunk", [page.source, 0]);
    console.log(`learner sourceFileChunk(${page.source}, 0): ${chunk.total} chunk(s), starts ${Buffer.from(chunk.base64.slice(0, 12), "base64").toString().slice(0, 5)}`);
  }
  const refused = await c.call("addPageImage", [cited[0]?.id ?? "s1", 1, "x"]).then(() => "allowed!", (e: unknown) => `refused: ${e instanceof Error ? e.message : e}`);
  console.log("learner addPageImage:", refused);
  c.close();
}

async function turn(c: AgentClient, input: Record<string, unknown>) {
  const t0 = Date.now();
  const steps: string[] = [];
  const r = await new Promise<{ reply: string; actions: unknown[]; blocks: { id: string; kind: string; status: string }[]; ask?: { id: string; prompt: string; options: string[] }; model_calls: number; stopped?: string }>((resolve, reject) => {
    void c.call("tutorTurn", [input], {
      stream: {
        onChunk: (chunk) => {
          const e = chunk as { type: string; label?: string };
          if (e.type === "step") steps.push(e.label!);
        },
        onDone: (final) => resolve((final as { result: never }).result),
        onError: (error) => reject(new Error(error)),
      },
    });
  });
  console.log(`\n> ${String(input.text)}${input.shortcut ? ` [${String(input.shortcut)}]` : ""}\n  ${t(t0)}, ${r.model_calls} model calls${r.stopped ? ` (stopped: ${r.stopped})` : ""}; steps: ${steps.join(" · ")}`);
  console.log(`  reply: ${r.reply.slice(0, 400)}`);
  if (r.actions.length) console.log(`  actions: ${JSON.stringify(r.actions)}`);
  if (r.blocks.length) console.log(`  blocks: ${JSON.stringify(r.blocks)}`);
  if (r.ask) console.log(`  ask: ${r.ask.prompt} | ${r.ask.options.join(" | ")}`);
  if (/"correct"/.test(JSON.stringify(r))) console.log("  !! the turn result contains \"correct\"");
  return r;
}

type Personal = { id: string; kind: string; status: string; approach: string | null; pieces: { kind: string; markdown?: string; id?: string; intervention?: { template: string } }[]; provenance: { pages: unknown[]; fact_check: string; made_for?: string } | null; problems: string[] };
async function waitBlocks(c: AgentClient, lesson: string): Promise<Personal[]> {
  const t0 = Date.now();
  for (;;) {
    const blocks = await c.call<Personal[]>("personalBlocks", [lesson]);
    if (!blocks.some((b) => b.status === "running") || Date.now() - t0 > 300_000) {
      for (const b of blocks) {
        const kinds = b.pieces.map((p) => (p.kind === "widget" ? `widget:${p.intervention?.template}` : p.kind)).join(",");
        const figs = b.pieces.flatMap((p) => [...(p.markdown ?? "").matchAll(/\]\((fig|gen):([^)]+)\)/g)].map((m) => `${m[1]}:${m[2]}`));
        console.log(`  block ${b.kind} ${b.status} ${b.approach ?? ""} (${t(t0)}): pieces ${kinds}; figures ${JSON.stringify(figs)}; provenance ${JSON.stringify(b.provenance)}${b.problems.length ? `; problems ${b.problems.join(" | ").slice(0, 300)}` : ""}`);
      }
      if (/"correct"/.test(JSON.stringify(blocks))) console.log("  !! personal blocks contain \"correct\"");
      return blocks;
    }
    await sleep(3_000);
  }
}

/** The lesson and section the script talks about: Amdahl's law if the course has it. */
function pick(s: Snapshot) {
  const lesson = s.lessons.find((l) => /amdahl|speedup|efficien/i.test(JSON.stringify(l.sections.map((x) => x.title)))) ?? s.lessons[0]!;
  const section = lesson.sections.find((x) => /amdahl|speedup|efficien|limit/i.test(x.title)) ?? lesson.sections[0]!;
  return { lesson, section };
}

async function tutor() {
  const id = courseId();
  await join(id, "join_learner");
  const c = await open("course-agent", id, "join_learner");
  const s = await c.call<Snapshot>("snapshot", []);
  const { lesson, section } = pick(s);
  console.log(`lesson ${lesson.id}, section ${section.id} "${section.title}"`);
  const first = await turn(c, { lesson: lesson.id, section: section.id, text: "I don't get why adding more processors stops helping" });
  if (first.ask) {
    const pickWrong = first.ask.options.length - 1;
    console.log("  answered:", JSON.stringify(await c.call("answerAsk", [first.ask.id, pickWrong])).slice(0, 300));
    await turn(c, { lesson: lesson.id, section: section.id, text: `I answered: "${first.ask.options[pickWrong]}"` });
  }
  await waitBlocks(c, lesson.id);
  await turn(c, { lesson: lesson.id, section: section.id, text: "Can you draw how the sequential part limits the speedup?" });
  await turn(c, { lesson: lesson.id, section: section.id, text: "Give me something I can play with: sliders for the parallel fraction and the number of processors." });
  const blocks = await waitBlocks(c, lesson.id);
  for (const b of blocks.filter((x) => x.status === "ready")) {
    for (const p of b.pieces) {
      if (p.kind === "image" && p.id) console.log(`  generatedImage(${p.id}) for the learner:`, ((await c.call<{ mime: string; base64: string }>("generatedImage", [p.id])).mime));
      for (const m of (p.markdown ?? "").matchAll(/\]\(fig:([^)]+)\)/g)) console.log(`  figure(${m[1]}) for the learner:`, JSON.stringify(await c.call("figure", [m[1]])).slice(0, 120));
    }
  }
  c.close();
  // Another learner can't fetch this learner's picture.
  const image = blocks.flatMap((b) => b.pieces).find((p) => p.kind === "image")?.id;
  if (image) {
    await join(id, "join_other");
    const other = await open("course-agent", id, "join_other");
    console.log("  another learner's generatedImage:", await other.call("generatedImage", [image]).then(() => "allowed!", (e: unknown) => `refused: ${e instanceof Error ? e.message : e}`));
    other.close();
  }
}

async function voice(wav: string) {
  const id = courseId();
  await join(id, "join_learner");
  const pcm = readFileSync(wav).subarray(44);
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    const req = request(`http://${HOST}/agents/voice?course=${id}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.on("upgrade", (res) => resolve(res.statusCode ?? 101));
    req.end();
  });
  console.log("voice socket without a token:", status);
  const ws = new WebSocket(`ws://${HOST}/agents/voice?course=${id}&devUser=join_learner&devRole=learner`);
  ws.binaryType = "arraybuffer";
  const t0 = Date.now();
  let endAt = 0;
  ws.onopen = async () => {
    const frame = 16000 * 2 * 0.08;
    for (let i = 0; i < pcm.length; i += frame) {
      const slice = pcm.subarray(i, i + frame);
      ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
      await sleep(80);
    }
    endAt = Date.now();
    ws.send(JSON.stringify({ type: "end" }));
  };
  ws.onmessage = (e) => console.log(`  ${t(t0)}`, String(e.data).slice(0, 300), endAt ? `(${Date.now() - endAt} ms after the end)` : "");
  await new Promise<void>((resolve) => (ws.onclose = (e) => (console.log("  closed", e.code, e.reason), resolve())));
}

/** Three learners press "Explain differently" on one section, then "Quiz me on this", and answer right. */
async function promote() {
  const id = courseId();
  const o = await open("course-agent", id, OWNER);
  const authored = await o.call<Snapshot>("snapshot", []); // the owner's copy has the keys; a learner's doesn't
  o.close();
  const { lesson, section } = pick(authored);
  const keyOf = (prompt: string) => {
    for (const l of authored.lessons) {
      const item = l.quiz.find((q) => q.prompt === prompt);
      if (item?.options) return item.options.findIndex((x) => x.correct);
      for (const x of l.sections) for (const b of x.blocks as unknown as { check?: { prompt: string; options: { correct: boolean }[] } }[]) if (b.check?.prompt === prompt) return b.check.options.findIndex((y) => y.correct);
    }
    return 0;
  };
  for (const who of ["join_q1", "join_q2", "join_q3"]) {
    await join(id, who);
    const c = await open("course-agent", id, who);
    await turn(c, { lesson: lesson.id, section: section.id, text: "Explain this section differently.", shortcut: "explain" });
    await waitBlocks(c, lesson.id);
    const quiz = await turn(c, { lesson: lesson.id, section: section.id, text: "Quiz me on this section.", shortcut: "quiz" });
    if (quiz.ask) console.log("  answer:", JSON.stringify(await c.call("answerAsk", [quiz.ask.id, keyOf(quiz.ask.prompt)])).slice(0, 200));
    c.close();
  }
  const owner = await open("course-agent", id, OWNER);
  const rows = await owner.call<{ label: string; learners: number; fixed: number; repaired: number; key?: string; promote: { approach: string; fixed: number; shown: number } | null }[]>("coachInsights", []);
  for (const r of rows) console.log(`insight: ${r.label.slice(0, 70)} · ${r.learners} learners · fixed ${r.fixed}/${r.repaired} · promote ${JSON.stringify(r.promote)}`);
  const row = rows.find((r) => r.promote);
  if (row) {
    const t0 = Date.now();
    console.log("promoteRepair:", JSON.stringify(await owner.call("promoteRepair", [row.key ?? (row as { target_key?: string }).target_key])).slice(0, 300));
    for (;;) {
      await sleep(4_000);
      const edit = (await owner.call<{ edit: { status: string; steps: { title: string }[]; problems?: string[]; proposal?: { summary?: unknown[]; risk?: unknown } } | null }>("overview", [])).edit;
      if (edit && edit.status !== "running") {
        console.log(`edit ${edit.status} in ${t(t0)}: ${edit.steps.map((x) => x.title).join(" · ")} ${edit.problems?.join("; ") ?? ""}`);
        if (edit.proposal) console.log("proposal:", JSON.stringify(edit.proposal).slice(0, 600));
        break;
      }
      if (Date.now() - t0 > 300_000) {
        console.log("edit still running after 5 min");
        break;
      }
    }
  }
  owner.close();
}

async function integrity() {
  const id = courseId();
  await join(id, "join_learner");
  const c = await open("course-agent", id, "join_learner");
  const s = await c.call<Snapshot>("snapshot", []);
  const lesson = s.lessons[0]!;
  const has = (v: unknown) => (/"correct"/.test(JSON.stringify(v)) ? "HAS \"correct\"" : "no \"correct\"");
  console.log(`learner snapshot: ${JSON.stringify(s).length} chars, ${has(s)}, ${/"feedback"/.test(JSON.stringify(s)) ? "has" : "no"} "feedback"`);
  console.log(`learner exam(${lesson.id}): ${has(await c.call("exam", [lesson.id]))}`);
  const diag = await c.call<{ diagnosis?: { id: string; questions: unknown[] } }>("startDiagnosis", [lesson.id, "I mix up speedup and efficiency"]);
  console.log(`learner coachState after startDiagnosis: ${diag.diagnosis?.questions.length ?? 0} questions, ${has(diag)}`);
  console.log(`learner personalBlocks(${lesson.id}): ${has(await c.call("personalBlocks", [lesson.id]))}`);
  const o = await open("course-agent", id, OWNER);
  console.log(`owner snapshot: ${has(await o.call("snapshot", []))} (expected: the owner sees keys)`);
  o.close();
  c.close();
}

const [stage, a, b] = process.argv.slice(2);
if (stage === "setup") await setup(a!, b!);
else if (stage === "content") await content();
else if (stage === "tutor") await tutor();
else if (stage === "voice") await voice(a!);
else if (stage === "promote") await promote();
else if (stage === "integrity") await integrity();
else console.log("stage: setup <pdf> <pages dir> | content | tutor | voice <wav> | promote | integrity");
process.exit(0);
