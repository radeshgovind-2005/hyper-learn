import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import type { QuizItem } from "../assessment/items.js";
import { buildCourse, cannedBuilderModels } from "../generate/index.js";
import { EXAM, NOTES } from "../generate/fixtures.test-helpers.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import type { CourseBuilder } from "./courses.js";
import { CourseService } from "./service.js";

// The three workstreams together: an owner builds a course with the real generator (canned models, no
// network), publishes it, and a learner takes drawn exams, gets sent back to sections, and practises.

const canned: CourseBuilder = (input, _structured, onStep) => buildCourse(input, cannedBuilderModels(), { onStep });

async function published() {
  const s = new CourseService(sqlite(), {
    course: "studio",
    builder: canned,
    ownerModels: {
      secret: "test-only-secret-0123456789abcdefghijkl",
      config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
      choices: ["muse-spark-1.3"],
    },
  });
  s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner", name: "Ada" } });
  for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  const build = await s.continueBuild(s.beginBuild());
  assert.equal(build.status, "done", build.problems?.join("\n") ?? "build failed");
  s.publish();
  return s;
}

const ids = (items: readonly QuizItem[]) => items.map((item) => item.id);
const sure = (items: readonly QuizItem[]) => items.map(() => 3 as const);

describe("a generated studio course, end to end", () => {
  it("builds, publishes, and draws two questions per objective", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    const objectives = (s.snapshot().objectives ?? []).filter((o) => o.lesson === lesson.id);
    const exam = s.exam("user_bob", lesson.id);
    assert.equal(exam.release, "1.0.0");
    for (const o of objectives) assert.equal(exam.items.filter((item) => item.objective === o.id).length, 2);
  });

  it("lets one slip pass, sends a learner to the section of a missed objective, and retakes with new questions", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    const first = s.exam("user_bob", lesson.id);

    const missed = first.items[0]!.objective!;
    const answers = first.items.map((item) => (item.objective === missed ? wrongOptions(item, lesson.id)[0]!.response : correctResponse(item)));
    const result = s.submitQuiz("user_bob", lesson.id, answers, sure(first.items), undefined, ids(first.items));
    assert.equal(result.passed, false);
    const review = result.steps.filter((step) => step.kind === "review_section");
    assert.deepEqual(review.map((step) => step.kind === "review_section" && step.objective), [missed]);
    assert.deepEqual(s.progress("user_bob")[0]?.missed_objectives, [missed]);

    const retake = s.exam("user_bob", lesson.id);
    assert.equal(retake.attempt, 2);
    assert.equal(ids(retake.items).filter((id) => ids(first.items).includes(id)).length, 0, "unseen questions first");
    assert.throws(() => s.submitQuiz("user_bob", lesson.id, answers, sure(first.items), undefined, ids(first.items)), /load the exam again/);
  });

  it("passes an exam with one slip in four questions", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    const exam = s.exam("user_cy", lesson.id);
    assert.ok(exam.items.length >= 4);
    const answers = exam.items.map((item, i) => (i === 0 ? wrongOptions(item, lesson.id)[0]!.response : correctResponse(item)));
    assert.equal(s.submitQuiz("user_cy", lesson.id, answers, sure(exam.items), undefined, ids(exam.items)).passed, true);
  });

  it("answers a section check with its feedback and records it", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    const check = lesson.sections[0]!.blocks.find((block) => block.kind === "check");
    assert.ok(check && check.kind === "check");
    const right = check.check.options.findIndex((o) => o.correct);
    assert.deepEqual(s.answerCheck("user_bob", check.id, right), { correct: true, feedback: check.check.options[right]!.feedback });
    assert.equal(s.answerCheck("user_bob", check.id, right === 0 ? 1 : 0).correct, false);
    assert.deepEqual(
      s.events.forLearner("user_bob").filter((e) => e.kind === "check").map((e) => [e.release, (e.data as { correct: boolean }).correct]),
      [
        ["1.0.0", true],
        ["1.0.0", false],
      ],
    );
  });
});
