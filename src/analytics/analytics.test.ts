import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Grade } from "../assessment/grade.js";
import type { QuizItem } from "../assessment/items.js";
import { buildCourse } from "../course/validate.js";
import type { Lesson } from "../course/schema.js";
import type { QuizAttempt } from "../simulation/learners.js";
import { bktMastery, bktUpdate, DEFAULT_BKT } from "./bkt.js";
import { itemStatistics } from "./items.js";
import { computePerformance } from "./performance.js";

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
});
