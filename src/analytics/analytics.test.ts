import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Grade } from "../assessment/grade.js";
import type { QuizItem } from "../assessment/items.js";
import { buildCourse } from "../course/validate.js";
import type { Lesson } from "../course/schema.js";
import type { QuizAttempt } from "../simulation/learners.js";
import { bktMastery, bktUpdate, DEFAULT_BKT } from "./bkt.js";
import { itemStatistics } from "./items.js";
import { computePerformance, gradeAttempt } from "./performance.js";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import { drawExam } from "../assessment/exam.js";
import { courseFromSnapshot } from "../course/compile.js";
import { studioSnapshot } from "../course/fixtures/studio-course.js";
import { scenarioPerformance } from "../simulation/index.js";
import { getScenario } from "../simulation/scenarios.js";
import { formatPerformanceData } from "../state.js";

describe("BKT", () => {
  it("matches a hand-computed update", () => {
    // P(L|correct) = 0.2·0.9 / (0.2·0.9 + 0.8·0.25) = 0.18 / 0.38; then learning: + (1 − p)·0.1
    const posterior = 0.18 / 0.38;
    assert.equal(bktUpdate(0.2, true).toFixed(6), (posterior + (1 - posterior) * 0.1).toFixed(6));
    // P(L|wrong) = 0.2·0.1 / (0.2·0.1 + 0.8·0.75) = 0.02 / 0.62
    const wrongPosterior = 0.02 / 0.62;
    assert.equal(bktUpdate(0.2, false).toFixed(6), (wrongPosterior + (1 - wrongPosterior) * 0.1).toFixed(6));
  });

  it("rises with correct answers and falls with wrong ones", () => {
    assert.ok(bktMastery([true, true, true, true, true, true]) > 0.95);
    assert.ok(bktMastery([false, false, false]) < DEFAULT_BKT.prior + 0.1);
    assert.ok(bktMastery([true, true, false]) < bktMastery([true, true, true]));
  });
});

const g = (score: number): Grade => ({ score, correct: score === 1, errors: score === 1 ? [] : [{ points_to: "x" }] });

describe("itemStatistics", () => {
  // 40 attempts: strong learners (first half) get items 0–2 right; item 3 is right only for weak learners.
  const attempts = Array.from({ length: 40 }, (_, i) => {
    const strong = i < 20;
    return [g(strong ? 1 : i % 3 === 0 ? 1 : 0), g(strong ? 1 : 0), g(strong || i % 2 === 0 ? 1 : 0), g(strong ? 0 : 1)];
  });
  const stats = itemStatistics(["q0", "q1", "q2", "q3"], attempts);

  it("reports difficulty as the mean score", () => {
    assert.equal(stats[1]!.difficulty, 0.5);
  });

  it("flags an item that weak learners get right and strong learners get wrong", () => {
    assert.equal(stats[3]!.flag, "negative_discrimination");
    assert.ok(stats[3]!.discrimination < 0);
    // The broken item drags the rest-of-quiz totals the others are correlated with, so only require them positive.
    for (const s of stats.slice(0, 3)) assert.ok(s.discrimination > 0, s.item_id);
  });

  it("judges an item only on the attempts that showed it", () => {
    // The same 40 attempts, but each also shows q4 only half the time (undefined = not shown).
    const sparse = attempts.map((grades, i) => [...grades, i % 2 === 0 ? g(i < 20 ? 1 : 0) : undefined]);
    const withQ4 = itemStatistics(["q0", "q1", "q2", "q3", "q4"], sparse);
    assert.equal(withQ4[4]!.responses, 20);
    assert.equal(withQ4[4]!.flag, "too_few_responses");
    assert.ok(withQ4[4]!.discrimination > 0.5, "q4 separates strong from weak learners where it was shown");
    assert.equal(withQ4[0]!.responses, 40);
    assert.equal(withQ4[3]!.flag, "negative_discrimination");
  });

  it("gives the classic corrected item-total correlation when every item is shown", () => {
    const total = (a: readonly Grade[]) => a.reduce((sum, x) => sum + x.score, 0);
    const xs = attempts.map((a) => a[1]!.score);
    const ys = attempts.map((a) => total(a) - a[1]!.score);
    const mean = (v: number[]) => v.reduce((p, q) => p + q, 0) / v.length;
    const [mx, my] = [mean(xs), mean(ys)];
    const r =
      xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i]! - my), 0) /
      Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
    assert.equal(stats[1]!.discrimination, Math.round(r * 100) / 100);
  });

  it("doesn't judge items with too few responses", () => {
    assert.equal(itemStatistics(["q0", "q1"], attempts.slice(0, 5).map((a) => a.slice(0, 2)))[0]!.flag, "too_few_responses");
  });
});

describe("computePerformance: named misconceptions and broken items", () => {
  const item = (id: string): QuizItem => ({
    type: "single_choice",
    pilot: false,
    id,
    prompt: "?",
    options: [
      { text: "right", correct: true },
      { text: "belief", correct: false, misconception: "model-acts" },
      { text: "noise", correct: false },
    ],
  });
  // "broken" has its key on the wrong option: strong learners pick option 0 and are marked wrong.
  const broken: QuizItem = {
    type: "single_choice",
    pilot: false,
    id: "broken",
    prompt: "?",
    options: [
      { text: "actually right", correct: false },
      { text: "keyed as right", correct: true },
    ],
  };
  const lesson: Lesson = {
    id: "a",
    title: "A",
    summary: "",
    file: "",
    body: "",
    prerequisites: [],
    quiz: [item("q1"), item("q2"), item("q3"), item("q4"), broken],
  };
  const course = buildCourse({ id: "t", title: "T", misconceptions: [{ id: "model-acts", lesson: "a", belief: "b" }] }, [lesson]);

  // 30 strong learners (right on q1–q4, "wrong" on the miskeyed item), 30 believers (sure, belief on q1–q2).
  const attempts: QuizAttempt[] = [
    ...Array.from({ length: 30 }, (_, i): QuizAttempt => ({ learner_id: i, lesson_id: "a", answers: [0, 0, 0, 0, 0], certainty: [3, 3, 3, 3, 3] })),
    ...Array.from({ length: 30 }, (_, i): QuizAttempt => ({ learner_id: 30 + i, lesson_id: "a", answers: [1, 1, 2, 0, 1], certainty: [3, 3, 1, 2, 1] })),
  ];
  const [a] = computePerformance(course, course.graph, attempts);

  it("excludes a question with negative discrimination before diagnosing", () => {
    assert.deepEqual(a!.excluded_items, ["broken"]);
    assert.equal(a!.fail_rate, 0.5, "strong learners pass once the miskeyed item is excluded");
  });

  it("reports the belief as a share of failed attempts, with how confidently it was held", () => {
    assert.deepEqual(a!.misconceptions, [{ id: "model-acts", points_to: "a", share: 1, confident: 1, covered: false }]);
  });

  it("estimates mastery with BKT", () => {
    assert.equal(a!.mastery_rate, 0.5);
  });

  it("grades answers keyed by the items shown, in the order shown", () => {
    // Shown: q3 then q1 only. Answer 1 on q3 is the belief; 0 on q1 is right.
    const { grades, scored, passed } = gradeAttempt(lesson, { learner_id: 0, lesson_id: "a", item_ids: ["q3", "q1"], answers: [1, 0], certainty: [3, 1] });
    assert.deepEqual(scored.map((s) => [s.item.id, s.position, s.grade.correct]), [["q3", 0, false], ["q1", 1, true]]);
    assert.equal(grades.length, 2);
    assert.equal(passed, false);
  });

  it("grades attempts recorded without item_ids as the whole quiz, in order", () => {
    const old = gradeAttempt(lesson, { learner_id: 0, lesson_id: "a", answers: [0, 0, 0, 0, 1], certainty: [3, 3, 3, 3, 3] });
    const keyed = gradeAttempt(lesson, { learner_id: 0, lesson_id: "a", item_ids: lesson.quiz.map((q) => q.id), answers: [0, 0, 0, 0, 1], certainty: [3, 3, 3, 3, 3] });
    assert.deepEqual(keyed, old);
  });

  it("refuses item_ids that don't fit the answers or the quiz", () => {
    const attempt = (item_ids: string[], answers: number[]): QuizAttempt => ({ learner_id: 0, lesson_id: "a", item_ids, answers, certainty: answers.map(() => 3 as const) });
    assert.throws(() => gradeAttempt(lesson, attempt(["q1", "q2"], [0])), /2 items but has 1 answers/);
    assert.throws(() => gradeAttempt(lesson, attempt(["q1", "nope"], [0, 0])), /"nope", which is not in its quiz/);
    assert.throws(() => gradeAttempt(lesson, attempt(["q1", "q1"], [0, 0])), /shows an item twice/);
  });

  it("diagnoses attempts that each showed part of the pool", () => {
    // Same learners as above, but each attempt shows two of q1–q3 plus the broken item (q4 is never drawn).
    const pairs = [["q1", "q2"], ["q2", "q3"], ["q1", "q3"]];
    const sparse: QuizAttempt[] = attempts.map((full, i) => {
      const ids = [...pairs[i % 3]!, "broken"];
      return { ...full, item_ids: ids, answers: ids.map((id) => full.answers[lesson.quiz.findIndex((q) => q.id === id)]!), certainty: ids.map(() => 3 as const) };
    });
    const [node] = computePerformance(course, course.graph, sparse);
    assert.deepEqual(node!.excluded_items, ["broken"]);
    assert.equal(node!.fail_rate, 0.5);
  });
});

describe("computePerformance: objectives", () => {
  const course = courseFromSnapshot(studioSnapshot());
  const lesson = course.getLesson("cache-hits")!;
  // 40 drawn exams: right on "tell-hit-from-miss", wrong on "compute-hit-ratio".
  const attempts: QuizAttempt[] = Array.from({ length: 40 }, (_, i) => {
    const items = drawExam(lesson, course.objectives, { seed: i });
    return {
      learner_id: i,
      lesson_id: lesson.id,
      item_ids: items.map((item) => item.id),
      answers: items.map((item) => (item.objective === "compute-hit-ratio" ? wrongOptions(item, lesson.id)[0]!.response : correctResponse(item))),
      certainty: items.map(() => 2 as const),
    };
  });
  const [node] = computePerformance(course, course.graph, attempts);

  it("reports each objective's miss rate over the answers to its questions", () => {
    assert.deepEqual(node!.objectives, [
      { id: "tell-hit-from-miss", miss_rate: 0, responses: 40 },
      { id: "compute-hit-ratio", miss_rate: 1, responses: 40 },
    ]);
  });

  it("leaves objectives out for courses without them, and the Curator's legend as it was", () => {
    const data = scenarioPerformance(getScenario("control"));
    assert.ok(data.every((n) => !("objectives" in n)));
    assert.doesNotMatch(formatPerformanceData(data), /objectives/);
    assert.match(formatPerformanceData([node!]), /objectives = per learning objective/);
  });
});
