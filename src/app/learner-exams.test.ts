import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import type { QuizItem } from "../assessment/items.js";
import { getCourse } from "../course/bundle.js";
import { STUDIO_COURSE_ID, studioSnapshot } from "../course/fixtures/studio-course.js";
import { realPerformance } from "../measure/real.js";
import { sqlite } from "../node/sqlite.js";
import { CourseService } from "./service.js";

const NOW = "2026-10-29T12:00:00.000Z";
const featured = () => new CourseService(sqlite(), { now: () => NOW });
/** A service holding the studio fixture as its course. */
const studio = () =>
  new CourseService(sqlite(), { now: () => NOW, course: { id: STUDIO_COURSE_ID, base: studioSnapshot(), scenarios: [], exemplars: [] } });
const ids = (items: readonly QuizItem[]) => items.map((item) => item.id);
const right = (items: readonly QuizItem[]) => items.map((item) => correctResponse(item));
const sure = (items: readonly QuizItem[]) => items.map(() => 3 as const);
const wrongOn = (lesson: string, items: readonly QuizItem[], objective: string) =>
  items.map((item) => (item.objective === objective ? wrongOptions(item, lesson)[0]!.response : correctResponse(item)));

describe("exams on a course without exam config", () => {
  const quiz = getCourse().getLesson("agent-loop")!.quiz;

  it("shows the whole quiz in order, and accepts it with or without item_ids", () => {
    const s = featured();
    const exam = s.exam("ada", "agent-loop");
    assert.deepEqual(ids(exam.items), ids(quiz));
    assert.equal(exam.attempt, 1);
    assert.equal(s.submitQuiz("ada", "agent-loop", right(quiz), sure(quiz)).passed, true);
    assert.equal(s.submitQuiz("ada", "agent-loop", right(quiz), sure(quiz), undefined, ids(quiz)).passed, true);
    assert.equal(s.exam("ada", "agent-loop").attempt, 3);
  });

  it("refuses item_ids that aren't the quiz in order", () => {
    const s = featured();
    const reordered = [...ids(quiz)].reverse();
    assert.throws(() => s.submitQuiz("ada", "agent-loop", right(quiz), sure(quiz), undefined, reordered), /aren't the questions drawn/);
  });

  it("still grades answers stored before item_ids existed", () => {
    const s = featured();
    // An answer event as production stored it: no item_ids.
    const items = quiz.map((item) => ({ item_id: item.id, pilot: item.pilot, grade: { score: 1, correct: true, errors: [] } }));
    s.events.append({ learner: "old", kind: "answer", lesson: "agent-loop", release: "1.0.0", data: { responses: right(quiz), certainty: sure(quiz), items, passed: true, score: 1, attempt: 1 }, at: NOW });
    const node = realPerformance(s.snapshot(), "1.0.0", s.events.answers()).find((n) => n.node_id === "agent-loop")!;
    assert.equal(node.attempts, 1);
    assert.equal(node.fail_rate, 0);
    assert.equal(s.progress("old")[0]?.passed, true);
    assert.equal(s.exam("old", "agent-loop").attempt, 2);
  });
});

describe("exams drawn from a pool", () => {
  it("draws per objective, recomputes the same draw at submit, and records item_ids", () => {
    const s = studio();
    const exam = s.exam("ada", "cache-hits");
    assert.equal(exam.release, "1.0.0");
    assert.equal(exam.items.length, 3);
    assert.deepEqual(ids(s.exam("ada", "cache-hits").items), ids(exam.items), "the draw is recomputable");

    const result = s.submitQuiz("ada", "cache-hits", right(exam.items), sure(exam.items), "c1", ids(exam.items));
    assert.equal(result.passed, true);
    assert.deepEqual(result.items.map((i) => i.item_id), ids(exam.items));
    const [event] = s.events.forLearner("ada").filter((e) => e.kind === "answer");
    assert.deepEqual((event!.data as { item_ids: string[] }).item_ids, ids(exam.items));
  });

  it("draws a retake from questions the learner hasn't seen, and refuses the old draw", () => {
    const s = studio();
    const first = s.exam("ada", "cache-hits");
    s.submitQuiz("ada", "cache-hits", wrongOn("cache-hits", first.items, "compute-hit-ratio"), sure(first.items), undefined, ids(first.items));
    const retake = s.exam("ada", "cache-hits");
    assert.equal(retake.attempt, 2);
    const scored = (items: readonly QuizItem[]) => ids(items.filter((item) => !item.pilot));
    assert.equal(scored(retake.items).filter((id) => scored(first.items).includes(id)).length, 0);
    assert.throws(() => s.submitQuiz("ada", "cache-hits", right(first.items), sure(first.items), undefined, ids(first.items)), /aren't the questions drawn/);
  });

  it("refuses a submission without item_ids", () => {
    const s = studio();
    const { items } = s.exam("ada", "cache-hits");
    assert.throws(() => s.submitQuiz("ada", "cache-hits", right(items), sure(items)), /drawn per attempt/);
  });

  it("gives different learners different draws", () => {
    const s = studio();
    const draws = new Set(["a", "b", "c", "d", "e", "f"].map((learner) => ids(s.exam(learner, "eviction").items).join()));
    assert.ok(draws.size > 1);
  });

  it("sends a learner who missed an objective to its section, and reports it in progress", () => {
    const s = studio();
    const { items } = s.exam("ada", "cache-hits");
    const result = s.submitQuiz("ada", "cache-hits", wrongOn("cache-hits", items, "compute-hit-ratio"), sure(items), undefined, ids(items));
    assert.equal(result.passed, false);
    const review = result.steps.find((step) => step.kind === "review_section");
    assert.ok(review?.kind === "review_section");
    assert.equal(review.section_id, "cache-hits/hit-ratio");
    assert.equal(review.objective, "compute-hit-ratio");
    assert.deepEqual(s.progress("ada")[0]?.missed_objectives, ["compute-hit-ratio"]);
  });
});

describe("answerCheck", () => {
  const block = "cache-hits/hits-and-misses/k1";

  it("returns the feedback for the option picked and records it on the served release", () => {
    const s = studio();
    assert.deepEqual(s.answerCheck("ada", block, 0), { correct: true, feedback: "Right: a miss falls through to the store." });
    const wrong = s.answerCheck("ada", block, 1, "c1");
    assert.equal(wrong.correct, false);
    assert.match(wrong.feedback, /isn't a failure/);

    const checks = s.events.forLearner("ada").filter((e) => e.kind === "check");
    assert.equal(checks.length, 2);
    assert.equal(checks[1]!.release, s.myRelease("ada").version);
    assert.equal(checks[1]!.lesson, "cache-hits");
    assert.deepEqual(checks[1]!.data, { block_id: block, option: 1, correct: false, misconception: "miss-is-error", objective: "tell-hit-from-miss", session: "c1" });
  });

  it("refuses unknown checks and options", () => {
    const s = studio();
    assert.throws(() => s.answerCheck("ada", "cache-hits/hits-and-misses/p1", 0), /No check/);
    assert.throws(() => s.answerCheck("ada", block, 7), /no option 7/);
    assert.throws(() => s.answerCheck("ada", block, 0.5), /no option/);
  });

  it("shows checks in the learner's timeline, and not as quizzes", () => {
    const s = studio();
    s.answerCheck("ada", block, 1);
    const detail = s.learnerDetail("ada");
    // (learnerDetail still names lessons and beliefs from the featured course until C's course definitions land.)
    assert.match(detail.timeline[0]!.text, /^Practice check in .*: wrong, showing “/);
    assert.equal(detail.timeline[0]!.outcome, "fail");
    assert.equal(detail.progress.totals.quizzes, 0);
  });
});
