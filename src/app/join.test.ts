import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { QuizItem, Response } from "../assessment/items.js";
import { writeRepair } from "../coach/repair.js";
import { cannedSection, responder } from "../generate/canned.js";
import { buildCourse, cannedBuilderModels } from "../generate/index.js";
import { EXAM, NOTES } from "../generate/fixtures.test-helpers.js";
import type { SectionDraft } from "../generate/schemas.js";
import { parseAssetRef } from "../media/contracts.js";
import type { GeneratedImage } from "../meta/image.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import type { ModelStep, PersonalBlock, ToolCall, TutorMessage, TutorModel } from "../tutor/types.js";
import type { CoachRepairer, CourseBuilder } from "./courses.js";
import { CourseService, type TutorOptions } from "./service.js";

// The seams between stream A (sources, sight, the page) and stream B (the tutor), through the service:
// a studio course built by the real generator with canned models, page pictures read by a fake vision
// reader, and a scripted tutor model. Each test says which tools the "model" calls and checks what
// code did with the other stream's part. Nothing here reaches the network.

const JPEG = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, seed)]).toString("base64");
const webp = (): GeneratedImage => ({ mime: "image/webp", base64: btoa("RIFF\0\0\0\0WEBP".padEnd(2_000, "x")) });

/** The canned writer, plus the first figure it is offered, on a line of its own and citing its page (as the writer is told). */
function figureWriter(prompt: string): SectionDraft {
  const draft = cannedSection(prompt);
  const figure = /^- fig:(\S+) \(\w+, (\S+) p\.(\d+)\): (.+)$/m.exec(prompt);
  if (!figure) return draft;
  const [, id, source, page, caption] = figure;
  return { ...draft, blocks: [{ markdown: `![${caption}](fig:${id})`, cites: [{ source: source!, page: Number(page), quote: null }] }, ...draft.blocks] };
}

const models = () => ({ ...cannedBuilderModels(), writer: responder(figureWriter) });
const builder: CourseBuilder = (input, _s, onStep, extras) => buildCourse(input, models(), { onStep, ...(extras?.seer && { seer: extras.seer }) });
const repairer: CoachRepairer = (input) => writeRepair(input, models());

/** A scripted model: step n returns script[n] (or the last one), recording every prompt it saw. */
function scripted(script: ((messages: readonly TutorMessage[]) => ModelStep)[]) {
  const seen: TutorMessage[][] = [];
  const model: TutorModel = {
    async step(messages, _tools, onText) {
      seen.push([...messages]);
      const step = script[Math.min(seen.length - 1, script.length - 1)]!(messages);
      if (step.text) onText(step.text);
      return step;
    },
  };
  return { model, seen };
}
let callId = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `c${++callId}`, name, args });
const says = (text: string) => () => ({ text, calls: [] });
const uses = (...calls: ToolCall[]) => () => ({ text: "", calls });
const toolResults = (messages: readonly TutorMessage[]) => messages.filter((m): m is Extract<TutorMessage, { role: "tool" }> => m.role === "tool").map((m) => m.content);

/** A published course whose build looked at a picture of every page of the notes and found one chart on each. */
async function course(tutor: Partial<TutorOptions> = {}) {
  const holder: { model: TutorModel } = { model: scripted([says("Hello")]).model };
  const s = new CourseService(sqlite(), {
    course: "studio",
    builder,
    repairer,
    ownerModels: {
      secret: "test-only-secret-0123456789abcdefghijkl",
      config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
      choices: ["muse-spark-1.3"],
    },
    pageReader: () => ({
      read: async () => [{ kind: "chart", caption: "Stem growth by week", box: { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8 }, sam_prompt: "chart", table_markdown: null, latex: null, teaches: "Growth is steady." }],
    }),
    tutor: { model: () => holder.model, images: () => async () => webp(), ...tutor },
  });
  s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner" } });
  for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
  NOTES.pages.forEach((_, i) => s.addPageImage("s1", i + 1, JPEG(i + 1)));
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  const build = await s.continueBuild(s.beginBuild());
  assert.equal(build.status, "done", build.problems?.join() ?? "");
  s.publish();
  const lesson = s.snapshot().lessons[0]!;
  const section = lesson.sections[0]!;
  return { s, lesson, section, use: (m: TutorModel) => (holder.model = m) };
}

/** The tutor asks its diagnostic question and the learner answers it wrongly (looking up the key, as a test may). */
async function answerWrongly(s: CourseService, use: (m: TutorModel) => void, learner: string, lesson: string, section: string) {
  use(scripted([uses(call("ask_me", { section })), says("ok")]).model);
  const turn = await s.tutorTurn(learner, { lesson, section, text: "I don't get the notches" });
  assert.ok(turn.ask, "asked a question");
  const state = (s as unknown as { meta: { get: (k: string) => { asks: { id: string; source: { kind: string; item_id?: string; block_id?: string } }[] } } }).meta.get(`tutor:${learner}`);
  const source = state.asks.find((a) => a.id === turn.ask!.id)!.source;
  const snapshot = s.snapshot();
  const options =
    source.kind === "item"
      ? (snapshot.lessons.flatMap((l) => l.quiz).find((i) => i.id === source.item_id) as { options: { correct: boolean }[] }).options
      : (snapshot.lessons.flatMap((l) => l.sections.flatMap((x) => x.blocks)).find((b) => b.id === source.block_id) as { check: { options: { correct: boolean }[] } }).check.options;
  s.answerAsk(learner, turn.ask.id, options.findIndex((o) => !o.correct));
}

/** Runs what a turn started in the background, then the learner's blocks on the lesson. */
async function finished(s: CourseService, learner: string, lesson: string, blocks: readonly { id: string }[]): Promise<PersonalBlock[]> {
  for (const b of blocks) await s.continuePersonal(learner, b.id);
  return s.personalBlocks(learner, lesson);
}

describe("join: the tutor looks at the real page (J4a)", () => {
  it("look_at_page hands the model the stored picture of a cited page, with no page images injected", async () => {
    const { s, lesson, section, use } = await course();
    const { model, seen } = scripted([uses(call("look_at_page", { source: "s1", page: 2 })), says("I see the chart.")]);
    use(model);
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "What does page 2 show?" });
    assert.equal(turn.reply, "I see the chart.");
    const picture = seen[1]!.find((m) => m.role === "user" && "image" in m && m.image) as { image: { mime: string; base64: string } } | undefined;
    assert.ok(picture, "the picture went to the model in the next message");
    assert.deepEqual(picture.image, { mime: "image/jpeg", base64: JPEG(2) });
  });
});

describe("join: a personal rewrite keeps the section's figures (J4i)", () => {
  it("rewrite_for_me on a section whose pages have figures writes a block whose fig: ref resolves for that learner", async () => {
    const { s, lesson, section, use } = await course();
    assert.ok(s.ownerFigure("s1/p1/f1"), "the build stored the figures");
    await answerWrongly(s, use, "user_bob", lesson.id, section.id);
    use(scripted([uses(call("rewrite_for_me", { section: section.id, note: "the notches confuse me" })), says("Writing it for you.")]).model);
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "the notches confuse me" });
    const rewrite = (await finished(s, "user_bob", lesson.id, turn.blocks)).find((b) => b.kind === "rewrite")!;
    assert.equal(rewrite.status, "ready", rewrite.problems.join());
    const refs = rewrite.pieces.flatMap((p) => (p.kind === "text" ? [...p.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!) : []));
    assert.ok(refs.length > 0, "the rewrite shows a figure");
    for (const ref of refs) {
      const asset = parseAssetRef(ref);
      assert.equal(asset?.kind, "fig");
      const figure = s.figure("user_bob", asset!.id);
      assert.ok(section.blocks.some((b) => "cites" in b && b.cites?.some((c) => c.source === figure.source && c.page === figure.page)), "a figure of the section's own pages");
    }
  });

  it("an edit that rewrites a section keeps a figure it had", async () => {
    // The edit writer is the same as the build's: with figures passed, the figure line survives sectionFromDraft.
    const { runEdit } = await import("../edit/run.js");
    const { s, section } = await course();
    const figuresOn = (s as unknown as { figuresOn: (pages: readonly { source: string; page: number }[]) => unknown[] }).figuresOn;
    const result = await runEdit(
      { kind: "tune", section_id: section.id, preset: "plainer" },
      { course: { course_id: "c-abcdefghijkl", title: "Bramble Clocks" }, snapshot: s.snapshot(), sources: [NOTES, EXAM], figuresOn: figuresOn as never },
      { ...models(), editor: responder(() => ({ reply: "", rewrite_sections: [], new_sections: [], new_lessons: [], new_objectives: [], more_questions: [] })) },
    );
    assert.ok(result.ok, result.ok ? "" : result.problems.join());
    assert.match(JSON.stringify(result.proposal), /\]\(fig:s1\/p\d+\/f1\)/);
  });
});

describe("join: generated pictures are personal (J4d)", () => {
  it("a gen: image is served to the learner it was drawn for and refused to everyone else", async () => {
    const { s, lesson, section, use } = await course();
    use(scripted([uses(call("draw_it", { section: section.id, description: "a stem along a trellis with notches" })), says("ok")]).model);
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "draw it" });
    const diagram = (await finished(s, "user_bob", lesson.id, turn.blocks)).find((b) => b.kind === "diagram")!;
    assert.equal(diagram.status, "ready", diagram.problems.join());
    const piece = diagram.pieces.find((p) => p.kind === "image") as { id: string };
    assert.equal(parseAssetRef(`gen:${piece.id}`)?.kind, "gen", "the id is a valid gen: ref for Markdown.tsx");
    assert.equal(s.generatedImage("user_bob", piece.id).mime, "image/webp");
    assert.throws(() => s.generatedImage("user_eve", piece.id), /No such picture/);
    assert.deepEqual(s.personalBlocks("user_eve", lesson.id), [], "and eve sees no block of bob's");
  });
});

describe("join: interact takes A's widgets, checked by A's checks (J4e)", () => {
  const explorer = {
    template: "explorer",
    targets: "notches-are-fixed",
    title: "Notch spacing in the cold",
    formula: "24 / (g * c)",
    result_label: "Notch spacing (cm)",
    parameters: [
      { name: "g", label: "Daily growth (cm)", min: 1, max: 10, step: 1, value: 4 },
      { name: "c", label: "Cold factor", min: 0.5, max: 1, step: 0.1, value: 1 },
    ],
    plot: "g",
    takeaway: "Less growth per day means closer notches unless they are moved.",
  };

  async function interact(spec: unknown) {
    const { s, lesson, section, use } = await course();
    const { model, seen } = scripted([uses(call("interact", { section: section.id, spec: JSON.stringify(spec) })), says("ok")]);
    use(model);
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "let me try it" });
    return { turn, result: toolResults(seen[1]!)[0]!, blocks: s.personalBlocks("user_bob", lesson.id) };
  }

  it("accepts a valid explorer", async () => {
    const { turn, result, blocks } = await interact(explorer);
    assert.match(result, /Added the widget/);
    assert.equal(turn.blocks.length, 1);
    const widget = blocks[0]!.pieces[0] as { kind: string; intervention: { template: string } };
    assert.equal(widget.intervention.template, "explorer");
  });

  it("refuses a malformed explorer: plot not a parameter, or a formula that blows up on its range", async () => {
    for (const bad of [
      { ...explorer, plot: "x" },
      { ...explorer, formula: "sqrt(g - 5)" },
      { ...explorer, formula: "g +" },
      { ...explorer, parameters: [{ ...explorer.parameters[0]!, min: 5, max: 1 }] },
    ]) {
      const { turn, result, blocks } = await interact(bad);
      assert.match(result, /Refused: The widget isn't valid/, JSON.stringify(bad));
      assert.deepEqual(turn.blocks, []);
      assert.deepEqual(blocks, []);
    }
  });

  it("refuses a hostile one: code in the formula, markup in the text, unknown fields", async () => {
    for (const bad of [
      { ...explorer, formula: "constructor.constructor('return fetch')()" },
      { ...explorer, takeaway: "<img src=x onerror=alert(1)>" },
      { ...explorer, title: "[click](javascript:alert(1))" },
      { ...explorer, onload: "alert(1)" },
      { template: "compare", targets: "x", title: "t", cases: [{ label: "A", points: ["p"], figure: { label: "n", value: 1e300, unit: "" } }, { label: "a", points: ["p"], figure: null }], takeaway: "t" },
    ]) {
      const { result, blocks } = await interact(bad);
      assert.match(result, /Refused|isn't valid/, JSON.stringify(bad));
      assert.deepEqual(blocks, [], JSON.stringify(bad));
    }
  });
});

describe("join: learners reach only the sources their release cites (J4f)", () => {
  it("a figure, page picture or original of an uncited file is refused, and look_at_page doesn't show it", async () => {
    const { s, lesson, use } = await course();
    // A file added after publishing: the owner has it, the live release cites nothing in it.
    s.addSource({ name: "Bramble-Lec09.pdf", role: "material", pages: ["Grafting a second stem doubles the clock's range."] });
    s.addPageImage("s3", 1, JPEG(9));
    (s as unknown as { media: { setFigures: (source: string, page: number, figures: unknown[]) => void } }).media.setFigures("s3", 1, [
      { id: "s3/p1/f1", source: "s3", page: 1, kind: "figure", caption: "A graft", box: { x1: 0, y1: 0, x2: 1, y2: 1 }, table_markdown: null, latex: null, teaches: null },
    ]);
    s.addSourceFileChunk("s3", 0, Buffer.from("%PDF-1.7\nsecret").toString("base64"), 1);
    assert.ok(s.ownerFigure("s3/p1/f1") && s.ownerPageImage("s3", 1), "the owner has them");

    assert.throws(() => s.figure("user_bob", "s3/p1/f1"), /isn't shared with learners/);
    assert.throws(() => s.pageImage("user_bob", "s3", 1), /isn't shared with learners/);
    assert.throws(() => s.sourceFileChunk("user_bob", "s3", 0), /isn't shared with learners/);
    assert.equal(await s.pageImages("user_bob").get("s3", 1), null);
    // The cited file still works.
    assert.ok(s.figure("user_bob", "s1/p1/f1"));
    assert.ok(s.pageImage("user_bob", "s1", 1));

    const { model, seen } = scripted([uses(call("look_at_page", { source: "s3", page: 1 })), says("ok")]);
    use(model);
    await s.tutorTurn("user_bob", { lesson: lesson.id, text: "what's in lecture 9?" });
    assert.match(toolResults(seen[1]!)[0]!, /Refused: .*isn't a file the learner may open/);
    assert.ok(!seen[1]!.some((m) => "image" in m && m.image), "no picture reached the model");
  });

  it("every callable starts with this.actor(...), and the new ones need the permission the matrix gives them", () => {
    const agent = readFileSync(new URL("../../worker/course-agent.ts", import.meta.url), "utf8");
    const callables = [...agent.matchAll(/@callable\([^)]*\)\s*\n\s*(?:async\s+)?(\w+)\([^)]*\)[^{\n]*\{\n\s*(.+)\n/g)].map((m) => ({ name: m[1]!, first: m[2]! }));
    assert.ok(callables.length > 60, `found ${callables.length} callables`);
    for (const c of callables) assert.match(c.first, /this\.actor\(/, `${c.name} must start with this.actor(permission)`);
    const permission = (name: string) => /this\.actor\("(\w+)"\)/.exec(callables.find((c) => c.name === name)?.first ?? "")?.[1];
    const expected = {
      figure: "learn",
      pageImage: "learn",
      sourceFileChunk: "learn",
      generatedImage: "learn",
      tutorTurn: "learn",
      answerCoachCheck: "learn",
      promoteRepair: "repair",
      tutorSuggestions: "view_learners",
      addPageImage: "manage_course",
      addSourceFileChunk: "manage_course",
    };
    for (const [name, want] of Object.entries(expected)) assert.equal(permission(name), want, name);
  });
});

describe("join: no answer key reaches a learner (J4g, A6)", () => {
  const KEY = /"correct"|"feedback"/;

  it("no tutor turn result, personal block or dock state carries a key; a reply that states one is replaced", async () => {
    const { s, lesson, section, use } = await course();
    await answerWrongly(s, use, "user_bob", lesson.id, section.id);
    use(scripted([uses(call("read_section", { section: section.id }), call("rewrite_for_me", { section: section.id, note: "notches" })), says("Here you go.")]).model);
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "notches" });
    const blocks = await finished(s, "user_bob", lesson.id, turn.blocks);
    assert.ok(blocks.some((b) => b.kind === "rewrite" && b.pieces.some((p) => p.kind === "check")), "the rewrite has a practice question");
    for (const [what, value] of Object.entries({ turn, blocks, info: s.tutorInfo("user_bob", lesson.id) })) assert.doesNotMatch(JSON.stringify(value), KEY, what);

    const pending = s.exam("user_bob", lesson.id).items.find((i): i is Extract<QuizItem, { type: "single_choice" }> => i.type === "single_choice" && i.options.some((o) => o.correct && o.text.length >= 8));
    if (pending) {
      const right = pending.options.find((o) => o.correct)!.text;
      use(scripted([says(`The answer is: ${right}`)]).model);
      const leaked = await s.tutorTurn("user_bob", { lesson: lesson.id, text: "tell me about it" });
      assert.ok(!leaked.reply.includes(right), "the reply doesn't state the right answer");
    }
  });

  it("coachState() as learners get it has no key, and grading on that view still works", async () => {
    const { s } = await course();
    const lesson = s.snapshot().lessons[1] ?? s.snapshot().lessons[0]!;
    s.startDiagnosis("user_bob", lesson.id, "the notches confuse me");
    let view = s.coachState("user_bob", true);
    assert.doesNotMatch(JSON.stringify(view), KEY, "diagnosis questions");

    // Answer wrongly on the view, looking the key up in the authored items (as a test may; a browser can't).
    // Ordered parts are placed by their text, as the browser shows them: in the view's shuffled order.
    const authored = s.coachState("user_bob").diagnosis!.questions;
    const shown = view.diagnosis!.questions;
    const wrong = (item: QuizItem, onView: QuizItem): Response => {
      if (item.type === "single_choice") return item.options.findIndex((o) => !o.correct);
      if (item.type === "multi_select") return [item.options.findIndex((o) => !o.correct)];
      if (item.type === "two_tier") return [item.options.findIndex((o) => !o.correct), item.reasons.findIndex((r) => !r.correct)];
      if (item.type === "ordering" && onView.type === "ordering") return [...item.steps].reverse().map((step) => onView.steps.indexOf(step));
      throw new Error(`no wrong answer scripted for ${item.type}`);
    };
    view = s.submitDiagnosis("user_bob", view.diagnosis!.id, authored.map((q, i) => wrong(q.item, shown[i]!.item)), true);
    assert.doesNotMatch(JSON.stringify(view), KEY, "after the diagnosis");
    assert.notEqual(view.diagnosis!.result!.priority.kind, "ready");

    assert.equal(s.beginRepair("user_bob").write, true);
    await s.continueRepair("user_bob");
    view = s.coachState("user_bob", true);
    assert.equal(view.repair!.status, "ready", view.repair!.problems?.join() ?? "");
    assert.ok(view.repair!.lesson!.section.check.options.length > 0);
    assert.doesNotMatch(JSON.stringify(view), KEY, "the personal lesson and its re-check");

    // The practice question is graded on the server.
    const options = s.coachState("user_bob").repair!.lesson!.section.check.options as { text: string; correct: boolean; feedback: string }[];
    const right = options.findIndex((o) => o.correct);
    assert.deepEqual(s.answerCoachCheck("user_bob", view.repair!.id, right), { correct: true, feedback: options[right]!.feedback });
    assert.equal(s.answerCoachCheck("user_bob", view.repair!.id, (right + 1) % options.length).correct, false);
    assert.throws(() => s.answerCoachCheck("user_bob", "someone-elses", 0), /gone/);
    assert.throws(() => s.answerCoachCheck("user_bob", view.repair!.id, 99), /Pick one/);
  });
});

describe("join: the open-weights endpoint reaches vision, never Meta-only models (J2)", () => {
  const OPEN = "meta-models/muse-spark-open-1026";

  async function seeWith(model: string) {
    const seen: { baseURL?: string; segment?: boolean } = {};
    const s = new CourseService(sqlite(), {
      course: "studio",
      // Only the seer matters here: the fake build calls its reader once and stops.
      builder: async (_input, _s, _onStep, extras) => {
        seen.segment = Boolean(extras?.seer?.segment);
        await extras?.seer?.read({ mime: "image/jpeg", base64: JPEG(1) });
        return { ok: false, problems: ["stopped after seeing"], report: { steps: [], model_calls: 0, warnings: [] } };
      },
      ownerModels: {
        secret: "test-only-secret-0123456789abcdefghijkl",
        config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://api.meta.example/v1" }), apiKey: "" },
        choices: ["muse-spark-1.3", OPEN],
        endpoints: { [OPEN]: "https://open-weights.example/v1" },
      },
      pageReader: (config) => {
        seen.baseURL = config.baseURL;
        return { read: async () => [], segment: async () => [] };
      },
    });
    s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner" } });
    s.addSource({ name: NOTES.name, pages: NOTES.pages });
    s.addPageImage("s1", 1, JPEG(1));
    await s.setModelKey("sk-secret-123", model);
    await s.continueBuild(s.beginBuild());
    return { s, seen };
  }

  it("a Meta model: vision at Meta's host, with SAM", async () => {
    const { s, seen } = await seeWith("muse-spark-1.3");
    assert.deepEqual(seen, { segment: true, baseURL: "https://api.meta.example/v1" });
    assert.equal((await s.metaConfig()).baseURL, "https://api.meta.example/v1");
  });

  it("the open-weights model: vision at its own endpoint, no SAM, and no pictures or voice", async () => {
    const { s, seen } = await seeWith(OPEN);
    assert.deepEqual(seen, { segment: false, baseURL: "https://open-weights.example/v1" });
    await assert.rejects(s.metaConfig(), /need a Meta model key/);
  });
});
