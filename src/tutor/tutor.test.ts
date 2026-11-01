import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoachRepairer, CourseBuilder, CourseEditor } from "../app/courses.js";
import { CourseService, MAX_IMAGES_PER_DAY, MAX_TUTOR_TURNS_PER_DAY, type TutorOptions } from "../app/service.js";
import { writeRepair } from "../coach/repair.js";
import { runEdit } from "../edit/run.js";
import type { EditPlanDraft } from "../edit/schemas.js";
import { responder } from "../generate/canned.js";
import { buildCourse, cannedBuilderModels } from "../generate/index.js";
import { EXAM, NOTES } from "../generate/fixtures.test-helpers.js";
import type { SectionDraft } from "../generate/schemas.js";
import type { PageImage } from "../media/contracts.js";
import type { GeneratedImage } from "../meta/image.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import { MAX_TURN_CALLS } from "./loop.js";
import type { ModelStep, ToolCall, TutorMessage, TutorModel } from "./types.js";

// The tutor through the service, on a studio course built by the real generator with canned models,
// and a scripted tutor model: each test says which tools the "model" calls, and checks what code did.

const canned: CourseBuilder = (input, _s, onStep) => buildCourse(input, cannedBuilderModels(), { onStep });
const EMPTY_PLAN: EditPlanDraft = { reply: "", rewrite_sections: [], new_sections: [], new_lessons: [], new_objectives: [], more_questions: [] };

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

interface Setup {
  model?: TutorModel;
  repairer?: CoachRepairer;
  tutor?: Partial<TutorOptions>;
}

async function course({ model, repairer, tutor }: Setup = {}) {
  const holder: { model: TutorModel } = { model: model ?? scripted([says("Hello")]).model };
  const editor: CourseEditor = (request, context, _structured, onStep) => runEdit(request, context, { ...cannedBuilderModels(), editor: responder(() => EMPTY_PLAN) }, { onStep });
  const s = new CourseService(sqlite(), {
    course: "studio",
    builder: canned,
    editor,
    repairer: repairer ?? ((input) => writeRepair(input, cannedBuilderModels())),
    ownerModels: {
      secret: "test-only-secret-0123456789abcdefghijkl",
      config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
      choices: ["muse-spark-1.3"],
    },
    tutor: { model: () => holder.model, ...tutor },
  });
  s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner" } });
  for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  const build = await s.continueBuild(s.beginBuild());
  assert.equal(build.status, "done");
  s.publish();
  for (const id of s.sourceList().map((x) => x.id)) s.setSourceShared(id, true);
  const lesson = s.snapshot().lessons[0]!;
  const section = lesson.sections[0]!;
  return { s, lesson, section, use: (m: TutorModel) => (holder.model = m) };
}

const toolMessages = (messages: readonly TutorMessage[]) => messages.filter((m): m is Extract<TutorMessage, { role: "tool" }> => m.role === "tool");

/** Picks a right or a wrong option of the tutor's open question, by looking up its key (as a test may; a browser can't). */
function optionFor(s: CourseService, who: string, askId: string, right: boolean): number {
  const state = (s as unknown as { meta: { get: (k: string) => { asks: { id: string; source: { kind: string; item_id?: string; block_id?: string } }[] } } }).meta.get(`tutor:${who}`);
  const source = state.asks.find((a) => a.id === askId)!.source;
  const snapshot = s.snapshot();
  const options =
    source.kind === "item"
      ? (snapshot.lessons.flatMap((l) => l.quiz).find((i) => i.id === source.item_id) as { options: { correct: boolean }[] }).options
      : (snapshot.lessons.flatMap((l) => l.sections.flatMap((x) => x.blocks)).find((b) => b.id === source.block_id) as { check: { options: { correct: boolean }[] } }).check.options;
  return options.findIndex((o) => o.correct === right);
}

/** The tutor asks a learner its diagnostic question, and they answer it (wrongly, by default). */
async function askAndAnswer(s: CourseService, learner: string, lesson: string, section: string, right = false) {
  const { model } = scripted([uses(call("ask_me", { section })), says("ok")]);
  const tutor = (s as unknown as { options: { tutor: TutorOptions } }).options.tutor;
  const before = tutor.model;
  tutor.model = () => model;
  const turn = await s.tutorTurn(learner, { lesson, section, text: "I don't get the notches" });
  tutor.model = before;
  assert.ok(turn.ask, "asked a question");
  return { ask: turn.ask, result: s.answerAsk(learner, turn.ask.id, optionFor(s, learner, turn.ask.id, right)) };
}
const answerWrongly = (s: CourseService, learner: string, lesson: string, section: string) => askAndAnswer(s, learner, lesson, section, false);

describe("tutor: the tool loop (B1)", () => {
  it("reads in parallel, goes to the section, then answers; the dock sees step names and text", async () => {
    const { s, lesson, section } = await course();
    const { model, seen } = scripted([uses(call("read_section", { section: section.id }), call("read_page", { source: "s1", page: 1 })), uses(call("go_to", { lesson: lesson.id, section: section.id })), says("The notches mark growth.")]);
    const { use } = { use: (m: TutorModel) => ((s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => m) };
    use(model);
    const events: string[] = [];
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "Why are there notches?" }, (e) => events.push(e.type === "step" ? `step:${e.label}` : `text:${e.delta}`));
    assert.equal(turn.reply, "The notches mark growth.");
    assert.equal(turn.model_calls, 3);
    assert.deepEqual(turn.actions, [{ kind: "go_to_section", lesson: lesson.id, section: section.id }]);
    const tools = toolMessages(seen[2]!).map((m) => m.name);
    assert.deepEqual(tools, ["read_section", "read_page", "go_to"], "tool results in the order called");
    assert.ok(events[0]!.startsWith("step:Reading the lesson"));
    assert.ok(events.some((e) => e.startsWith("step:Reading page 1")));
    assert.ok(events.includes("text:The notches mark growth."));
    // The conversation is kept for the next turn.
    assert.deepEqual(s.tutorInfo("user_bob", lesson.id).history.map((m) => m.role), ["user", "assistant"]);
  });

  it("refuses unknown ids and tools that don't exist, and the loop carries on", async () => {
    const { s, lesson } = await course();
    const { model, seen } = scripted([uses(call("read_section", { section: "no/such" }), call("delete_course", {}), call("open_source", { source: "s9", page: 1 }), call("read_page", { source: "s1", page: 999 })), says("Sorry.")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, text: "hi" });
    assert.equal(turn.reply, "Sorry.");
    const [unknownSection, noTool, badSource, badPage] = toolMessages(seen[1]!).map((m) => m.content);
    assert.match(unknownSection!, /Refused: There is no section "no\/such"/);
    assert.match(noTool!, /there is no tool "delete_course"/);
    assert.match(badSource!, /isn't a file the learner may open/);
    assert.match(badPage!, /has pages 1 to/);
    assert.deepEqual(turn.actions, []);
  });

  it("stops at the call budget", async () => {
    const { s, lesson, section } = await course();
    const { model, seen } = scripted([uses(call("read_section", { section: section.id }))]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, text: "loop forever" });
    assert.equal(seen.length, MAX_TURN_CALLS);
    assert.equal(turn.model_calls, MAX_TURN_CALLS);
    assert.match(turn.stopped ?? "", /limit for one turn/);
  });

  it("keeps a daily quota, bounded input, and a 12-exchange window", async () => {
    const { s, lesson } = await course();
    const { model, seen } = scripted([says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    await assert.rejects(s.tutorTurn("user_bob", { lesson: lesson.id, text: "x".repeat(1_001) }), /under 1,000/);
    await assert.rejects(s.tutorTurn("user_bob", { lesson: "nope", text: "hi" }), /No lesson/);
    for (let i = 0; i < 15; i++) await s.tutorTurn("user_bob", { lesson: lesson.id, text: `question ${i}` });
    const last = seen.at(-1)!;
    // system + 12 exchanges + this turn's message
    assert.equal(last.length, 1 + 24 + 1);
    assert.match((last[1] as { content: string }).content, /question 2$/, "the oldest messages left the window");
    for (let i = 15; i < MAX_TUTOR_TURNS_PER_DAY; i++) await s.tutorTurn("user_bob", { lesson: lesson.id, text: "again" });
    await assert.rejects(s.tutorTurn("user_bob", { lesson: lesson.id, text: "one more" }), /questions to Muse today/);
    assert.equal(s.tutorInfo("user_bob").turns_left, 0);
    assert.equal(s.tutorInfo("user_eve").turns_left, MAX_TUTOR_TURNS_PER_DAY, "the quota is per learner");
  });

  it("never hands the model an answer key, and works without page pictures", async () => {
    const { s, lesson, section } = await course();
    const { model, seen } = scripted([uses(call("read_section", { section: section.id }), call("read_page", { source: "s1", page: 1 }), call("look_at_page", { source: "s1", page: 1 }), call("ask_me", { section: section.id }))]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "I'm lost" });
    const results = toolMessages(seen.length > 1 ? seen.at(-1)! : []);
    // The turn ended at the question, so the last prompt the model saw is the first; read the tool results from the service instead.
    assert.ok(turn.ask, "asked a question and stopped");
    assert.equal(turn.model_calls, 1);
    assert.equal(results.length, 0);
    const { model: m2, seen: s2 } = scripted([uses(call("read_section", { section: section.id }), call("read_page", { source: "s1", page: 1 }), call("look_at_page", { source: "s1", page: 1 })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => m2;
    await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "show me" });
    const contents = toolMessages(s2[1]!).map((m) => m.content);
    assert.equal(contents.length, 3);
    for (const content of contents) assert.doesNotMatch(content, /correct/i);
    assert.match(contents[2]!, /No picture of that page is available; here is its text/);
    assert.doesNotMatch(JSON.stringify(turn), /"correct"/, "the dock's answer carries no answer key");
    assert.deepEqual(Object.keys(turn.ask!).sort(), ["id", "lesson", "options", "prompt"]);
  });

  it("sends a page picture to the model when stream A's PageImages has one", async () => {
    const picture: PageImage = { mime: "image/png", base64: "iVBORw0KGgo=" };
    const { model, seen } = scripted([uses(call("look_at_page", { source: "s1", page: 2 })), says("I see it.")]);
    const { s, lesson } = await course({ model, tutor: { pageImages: () => ({ get: async (source, page) => (source === "s1" && page === 2 ? picture : null) }) } });
    await s.tutorTurn("user_bob", { lesson: lesson.id, text: "what's in the figure?" });
    const image = seen[1]!.find((m) => m.role === "user" && "image" in m && m.image);
    assert.deepEqual((image as { image: PageImage }).image, picture);
  });

  it("won't answer a question copied from the learner's own quiz, or say its answer", async () => {
    const { model, seen } = scripted([says("ok")]);
    const { s, lesson } = await course({ model });
    const pending = s.exam("user_bob", lesson.id).items[0]!;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, text: `What's the answer to this: ${pending.prompt}` });
    assert.equal(turn.model_calls, 0);
    assert.equal(seen.length, 0, "no model call");
    assert.match(turn.reply, /question from your quiz/);
    const right = pending.type === "single_choice" ? pending.options.find((o) => o.correct)!.text : null;
    if (right && right.length >= 8) {
      const { model: leaky } = scripted([says(`The answer is: ${right}`)]);
      (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => leaky;
      const leaked = await s.tutorTurn("user_bob", { lesson: lesson.id, text: "tell me about it" });
      assert.match(leaked.reply, /can't give you the answer/);
    }
  });
});

describe("tutor: personal blocks (B3)", () => {
  it("asks first, then rewrites the section for this learner only; undo and a second rewrite", async () => {
    const { s, lesson, section } = await course();
    const rewrite = scripted([uses(call("rewrite_for_me", { section: section.id, note: "the notches confuse me" })), says("Writing it for you.")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => rewrite.model;
    const early = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "the notches confuse me" });
    assert.deepEqual(early.blocks, []);
    assert.match(toolMessages(rewrite.seen[1]!)[0]!.content, /ask a diagnostic question first/);

    await answerWrongly(s, "user_bob", lesson.id, section.id);
    const again = scripted([uses(call("rewrite_for_me", { section: section.id, note: "the notches confuse me" })), says("Writing it for you.")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => again.model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "the notches confuse me" });
    assert.equal(turn.blocks.length, 1);
    assert.equal(turn.blocks[0]!.status, "running");
    await s.continuePersonal("user_bob", turn.blocks[0]!.id);
    const [block] = s.personalBlocks("user_bob", lesson.id);
    assert.equal(block!.status, "ready", block!.problems.join());
    assert.equal(block!.section, section.id);
    assert.ok(block!.pieces.some((p) => p.kind === "text"));
    const check = block!.pieces.find((p) => p.kind === "check");
    assert.ok(check && !JSON.stringify(check).includes("correct"), "the practice question reaches the browser without its answer");
    assert.equal(block!.provenance!.fact_check, "supported");
    assert.ok(block!.provenance!.pages.length > 0);
    assert.match(block!.provenance!.made_for!, /you picked/);
    assert.deepEqual(s.personalBlocks("user_eve", lesson.id), [], "never shown to anyone else");
    assert.ok(s.answerPersonal("user_bob", block!.id, 0).feedback);
    assert.throws(() => s.answerPersonal("user_eve", block!.id, 0), /gone/);

    // A second rewrite replaces the first; undo takes it down.
    const second = scripted([uses(call("rewrite_for_me", { section: section.id, note: "still lost" })), says("Another way.")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => second.model;
    const next = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "still lost" });
    await s.continuePersonal("user_bob", next.blocks[0]!.id);
    const live = s.personalBlocks("user_bob", lesson.id);
    assert.deepEqual(live.map((b) => b.id), [next.blocks[0]!.id]);
    assert.notEqual(live[0]!.approach, block!.approach, "the retry changes approach");
    assert.throws(() => s.undoPersonal("user_eve", live[0]!.id), /gone/);
    s.undoPersonal("user_bob", live[0]!.id);
    assert.deepEqual(s.personalBlocks("user_bob", lesson.id), []);
  });

  it("refuses a draft that cites a page off the section: \"I couldn't ground that\"", async () => {
    const canned = cannedBuilderModels();
    const offPage = { invoke: async (m: never) => ({ ...(await canned.writer.invoke(m)), blocks: [{ markdown: "Bramble clocks run on batteries.", cites: [{ source: "s1", page: 3 }] }] }) as SectionDraft };
    const { s, lesson, section } = await course({ repairer: (input) => writeRepair(input, { writer: offPage as never, fact_checker: canned.fact_checker }) });
    await answerWrongly(s, "user_bob", lesson.id, section.id);
    const { model } = scripted([uses(call("rewrite_for_me", { section: section.id, note: "why?" })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "why?" });
    await s.continuePersonal("user_bob", turn.blocks[0]!.id);
    const [block] = s.personalBlocks("user_bob", lesson.id);
    assert.equal(block!.status, "failed");
    assert.match(block!.problems[0]!, /couldn't ground that/);
    assert.deepEqual(block!.pieces, []);
  });

  it("writes once for learners who asked through a shortcut (no words of their own)", async () => {
    let writes = 0;
    const { s, lesson, section } = await course({
      repairer: (input) => {
        writes++;
        return writeRepair(input, cannedBuilderModels());
      },
    });
    const shortcut = () => scripted([uses(call("rewrite_for_me", { section: section.id, note: "" })), says("ok")]).model;
    for (const who of ["user_a", "user_b"]) {
      (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = shortcut;
      const turn = await s.tutorTurn(who, { lesson: lesson.id, section: section.id, text: "Give me an example", shortcut: "example" });
      for (const b of turn.blocks) await s.continuePersonal(who, b.id);
    }
    assert.equal(writes, 1, "the second learner got the shared one");
    const [a, b] = [s.personalBlocks("user_a", lesson.id)[0]!, s.personalBlocks("user_b", lesson.id)[0]!];
    assert.equal(a.approach, "worked_example");
    assert.deepEqual(b.pieces, a.pieces);
  });

  it("adds a validated widget at once, and refuses a malformed one", async () => {
    const { s, lesson, section } = await course();
    const good = {
      template: "contrast",
      targets: "part-1-a-mix-up-1",
      belief: "More notches mean a faster clock",
      why_it_seems_right: "More marks look like more ticks",
      what_actually_happens: "Each notch marks a fixed amount of growth",
      check: { prompt: "A clock with more notches over the same stem is…", options: [{ text: "finer", correct: true, misconception: null, feedback: "Yes." }, { text: "faster", correct: false, misconception: "part-1-a-mix-up-1", feedback: "No." }] },
    };
    const { model, seen } = scripted([uses(call("interact", { section: section.id, spec: JSON.stringify(good) }), call("interact", { section: section.id, spec: '{"template":"slider"}' })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const turn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "let me try" });
    assert.equal(turn.blocks.length, 1);
    assert.equal(turn.blocks[0]!.status, "ready");
    assert.match(toolMessages(seen[1]!)[1]!.content, /Refused: The widget isn't valid/);
    const widget = s.personalBlocks("user_bob", lesson.id)[0]!;
    assert.equal(widget.kind, "widget");
  });
});

describe("tutor: generated pictures (B5)", () => {
  const webp = (size: number): GeneratedImage => ({ mime: "image/webp", base64: btoa("RIFF\0\0\0\0WEBP".padEnd(size, "x")) });

  it("draws once per prompt, keeps the daily cap, serves a picture only to whoever is shown it, refuses oversized ones", async () => {
    let made = 0;
    let size = 2_000;
    const { s, lesson, section } = await course({ tutor: { images: () => async () => (made++, webp(size)) } });
    const draw = async (who: string, description: string) => {
      const { model } = scripted([uses(call("draw_it", { section: section.id, description })), says("ok")]);
      (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
      const turn = await s.tutorTurn(who, { lesson: lesson.id, section: section.id, text: "draw it" });
      for (const b of turn.blocks) await s.continuePersonal(who, b.id);
      return s.personalBlocks(who, lesson.id).find((b) => b.kind === "diagram")!;
    };
    const first = await draw("user_bob", "a stem with notches, labelled 'one week'");
    assert.equal(first.status, "ready", first.problems.join());
    const piece = first.pieces[0] as { kind: "image"; id: string };
    assert.equal(made, 1);
    assert.equal(s.generatedImage("user_bob", piece.id).mime, "image/webp");
    assert.throws(() => s.generatedImage("user_eve", piece.id), /No such picture/);
    const same = await draw("user_eve", "a stem with notches, labelled 'one week'");
    assert.equal(made, 1, "the same prompt is a cache hit");
    assert.equal((same.pieces[0] as { id: string }).id, piece.id);
    assert.ok(s.generatedImage("user_eve", piece.id), "shown in eve's block, so eve may fetch it");

    size = 600_000;
    const big = await draw("user_bob", "something enormous");
    assert.equal(big.status, "failed");
    assert.match(big.problems[0]!, /too large/);

    size = 2_000;
    for (let i = 0; i < MAX_IMAGES_PER_DAY; i++) await draw("user_cy", `picture number ${i}`);
    const { model } = scripted([uses(call("draw_it", { section: section.id, description: "one too many" })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const over = await s.tutorTurn("user_cy", { lesson: lesson.id, section: section.id, text: "more" });
    assert.deepEqual(over.blocks, []);
  });

  it("a failed picture leaves the learner's rewrite intact; a storyboard keeps at most two pictures", async () => {
    let fail = true;
    const { s, lesson, section } = await course({
      tutor: {
        images: () => async () => {
          if (fail) throw new Error("image model down");
          return webp(1_000);
        },
        storyboard: () => ({
          invoke: async () => ({
            title: "How notches work",
            frames: [1, 2, 3, 4].map((n) => ({ caption: `Frame ${n}`, narration: `Narration ${n}`, picture: true, picture_description: `diagram ${n}` })),
          }),
        }),
      },
    });
    // "Explain differently" starts the rewrite in code; then the learner asks for a picture.
    const rewritten = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "Explain differently", shortcut: "explain" });
    assert.equal(rewritten.model_calls, 0);
    const { model } = scripted([uses(call("draw_it", { section: section.id, description: "notches" })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
    const drawn = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "draw the notches" });
    for (const b of [...rewritten.blocks, ...drawn.blocks]) await s.continuePersonal("user_bob", b.id);
    const blocks = s.personalBlocks("user_bob", lesson.id);
    assert.equal(blocks.find((b) => b.kind === "rewrite")!.status, "ready");
    assert.equal(blocks.find((b) => b.kind === "diagram")!.status, "failed");

    fail = false;
    const story = scripted([uses(call("storyboard", { section: section.id })), says("ok")]);
    (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => story.model;
    const t2 = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "show me a story" });
    await s.continuePersonal("user_bob", t2.blocks[0]!.id);
    const board = s.personalBlocks("user_bob", lesson.id).find((b) => b.kind === "storyboard")!;
    assert.equal(board.status, "ready", board.problems.join());
    const frames = (board.pieces[0] as { frames: { image?: string }[] }).frames;
    assert.equal(frames.length, 4);
    assert.equal(frames.filter((f) => f.image).length, 2);
  });
});

describe("tutor: outcomes, the bandit and promotion (B6)", () => {
  it("counts a rewrite's outcome on the next question, and offers promotion after 3 fixed learners", async () => {
    const { s, lesson, section } = await course();
    const fixOne = async (who: string, fixed: boolean) => {
      // "Explain differently": the section's own objective is the target, and the approach is fixed (smaller steps).
      const { model } = scripted([uses(call("rewrite_for_me", { section: section.id, note: "" })), says("ok")]);
      (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
      const turn = await s.tutorTurn(who, { lesson: lesson.id, section: section.id, text: "Explain differently", shortcut: "explain" });
      for (const b of turn.blocks) await s.continuePersonal(who, b.id);
      // The follow-up question on the section, answered right (fixed) or wrong.
      await askAndAnswer(s, who, lesson.id, section.id, fixed);
    };
    await fixOne("user_1", true);
    await fixOne("user_2", true);
    await fixOne("user_x", false);
    assert.ok(s.coachInsights().every((r) => r.promote === null), "with 2 fixed, nothing to promote yet");
    const key = s.coachInsights()[0];
    assert.ok(key);
    assert.throws(() => s.beginPromotion(key.key, "user_ada"), /at least 3/);
    await fixOne("user_3", true);
    const row = s.coachInsights().find((r) => r.promote);
    assert.ok(row, "with 3 fixed, a promotion appears");
    assert.equal(row.promote!.fixed, 3);
    assert.equal(row.promote!.shown, 4);
    assert.equal(row.promote!.approach, "smaller_steps");
    const edit = await s.continueEdit(s.beginPromotion(row.key, "user_ada"));
    assert.equal(edit.request.kind, "tune");
    assert.match(edit.request.kind === "tune" ? (edit.request.instruction ?? "") : "", /3 of 4 learners/);
    assert.ok(["ready", "failed"].includes(edit.status), "it went through the edit harness");
  });
});

describe("tutor: the open-weights switch (B7)", () => {
  it("runs on the open model's own endpoint when the owner picks it, refuses unknown models, and says which model", async () => {
    let seenBaseURL: string | undefined;
    let seenModel: string | undefined;
    const { model } = scripted([says("ok")]);
    const s = new CourseService(sqlite(), {
      course: "studio",
      builder: canned,
      repairer: (input) => writeRepair(input, cannedBuilderModels()),
      ownerModels: {
        secret: "test-only-secret-0123456789abcdefghijkl",
        config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://api.meta.example/v1" }), apiKey: "" },
        choices: ["muse-spark-1.3", "meta-models/muse-spark-open-1026"],
        endpoints: { "meta-models/muse-spark-open-1026": "https://model-x.api.baseten.example/v1" },
      },
      tutor: {
        model: (provider) => {
          seenModel = provider.models.reasoning;
          seenBaseURL = (provider.chat("reasoning") as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL;
          return model;
        },
      },
    });
    s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner" } });
    for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
    await assert.rejects(s.setModelKey("sk-baseten-123456", "some-other-model"), /Pick one of these models/);
    await s.setModelKey("sk-baseten-123456", "meta-models/muse-spark-open-1026");
    await s.continueBuild(s.beginBuild());
    s.publish();
    const lesson = s.snapshot().lessons[0]!;
    await s.tutorTurn("user_bob", { lesson: lesson.id, text: "hi" });
    assert.equal(seenModel, "meta-models/muse-spark-open-1026");
    assert.equal(seenBaseURL, "https://model-x.api.baseten.example/v1");
    assert.equal(s.tutorInfo("user_bob").model, "meta-models/muse-spark-open-1026");
    await assert.rejects(s.metaConfig(), /need a Meta model key/);
  });
});

describe("tutor: the dock's shortcuts", () => {
  it("answers them in code: a rewrite of the section in view, or a question on it, with no model call", async () => {
    const { model, seen } = scripted([says("unused")]);
    const { s, lesson, section } = await course({ model });
    const example = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "Give me an example", shortcut: "example" });
    assert.equal(example.model_calls, 0);
    assert.deepEqual(example.actions, [{ kind: "go_to_section", lesson: lesson.id, section: section.id }]);
    assert.equal(example.blocks[0]!.kind, "rewrite");
    const quiz = await s.tutorTurn("user_bob", { lesson: lesson.id, section: section.id, text: "Quiz me", shortcut: "quiz" });
    assert.ok(quiz.ask);
    assert.equal(seen.length, 0);
  });
});

describe("tutor: where it runs", () => {
  it("is off on a built-in course unless the Worker opts in, and never rewrites there", async () => {
    const off = new CourseService(sqlite());
    const lesson = off.snapshot().lessons[0]!;
    assert.equal(off.tutorInfo("user_bob").available, false);
    await assert.rejects(off.tutorTurn("user_bob", { lesson: lesson.id, text: "hi" }), /isn't available/);
    const { model, seen } = scripted([uses(call("rewrite_for_me", { section: lesson.sections[0]!.id, note: "x" })), says("ok")]);
    const on = new CourseService(sqlite(), { agentsAvailable: true, tutor: { model: () => model, meta: { baseURL: "https://api.example.com/v1", apiKey: "k" } } });
    assert.equal(on.tutorInfo("user_bob").available, true);
    const shortcut = await on.tutorTurn("user_bob", { lesson: lesson.id, text: "explain", shortcut: "explain" });
    assert.deepEqual(shortcut.blocks, []);
    assert.match(shortcut.reply, /Personal rewrites need a course built from its own pages/);
    const turn = await on.tutorTurn("user_bob", { lesson: lesson.id, text: "rewrite it for me" });
    assert.deepEqual(turn.blocks, []);
    assert.match(toolMessages(seen[1]!)[0]!.content, /Personal rewrites need a course built from its own pages/);
  });
});

describe("tutor: the independent verifier (B8)", () => {
  it("turns a disagreement into a doubt on the block, and a failed check leaves the first verdict", async () => {
    let mode: "disagree" | "fail" = "disagree";
    const { s, lesson, section } = await course({
      tutor: {
        verifier: async () => {
          if (mode === "fail") throw new Error("verifier down");
          return { supported: false, unsupported: ['"notches are weekly" — the page says daily'] };
        },
      },
    });
    // Each on its own section: through a shortcut, a second learner on the same section would get the first one's block.
    const rewrite = async (who: string, sectionId = section.id) => {
      const { model } = scripted([uses(call("rewrite_for_me", { section: sectionId, note: "" })), says("ok")]);
      (s as unknown as { options: { tutor: TutorOptions } }).options.tutor.model = () => model;
      const turn = await s.tutorTurn(who, { lesson: lesson.id, section: sectionId, text: "help", shortcut: "explain" });
      for (const b of turn.blocks) await s.continuePersonal(who, b.id);
      return s.personalBlocks(who, lesson.id)[0]!;
    };
    const doubted = await rewrite("user_a");
    assert.equal(doubted.provenance!.fact_check, "doubted");
    assert.match(doubted.problems[0]!, /page says daily/);
    mode = "fail";
    const kept = await rewrite("user_b", lesson.sections[1]!.id);
    assert.equal(kept.provenance!.fact_check, "supported");
  });
});
