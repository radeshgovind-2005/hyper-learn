import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCourse } from "../course/load.js";
import type { Lesson } from "../course/schema.js";
import { computePerformance, MIN_RELIABLE_ATTEMPTS, wilsonInterval } from "./performance.js";

// Two lessons; each question: option 0 correct, 1 reveals a gap in "a", 2 is a gap in the lesson itself.
const question = (id: string, gap?: string) => ({
  id,
  prompt: "?",
  options: [
    { text: "right", correct: true },
    gap ? { text: "gap", correct: false, reveals_gap_in: gap } : { text: "x", correct: false },
    { text: "self", correct: false },
  ],
});
const lessons: Lesson[] = [
  { id: "a", title: "A", summary: "", file: "", body: "", prerequisites: [], quiz: [question("a1"), question("a2")] },
  { id: "b", title: "B", summary: "", file: "", body: "", prerequisites: ["a"], quiz: [question("b1", "a"), question("b2", "a")] },
];
const course = buildCourse({ id: "t", title: "T" }, lessons);

describe("wilsonInterval", () => {
  it("brackets the observed rate and narrows with more data", () => {
    const [low, high] = wilsonInterval(50, 100);
    assert.ok(low < 0.5 && high > 0.5);
    const [low2, high2] = wilsonInterval(500, 1000);
    assert.ok(high2 - low2 < high - low);
  });

  it("matches a known value", () => {
    const [low, high] = wilsonInterval(10, 100);
    assert.equal(low.toFixed(4), "0.0552");
    assert.equal(high.toFixed(4), "0.1744");
  });
});

describe("computePerformance", () => {
  it("grades attempts and attributes wrong answers to the gap they reveal", () => {
    const data = computePerformance(course, course.graph, [
      { learner_id: 1, lesson_id: "b", answers: [0, 0] }, // pass
      { learner_id: 2, lesson_id: "b", answers: [1, 1] }, // fail, both reveal "a"
      { learner_id: 3, lesson_id: "b", answers: [0, 2] }, // 50% < 75% → fail, gap in "b" itself
    ]);

    assert.equal(data.length, 1, "lessons nobody took are left out");
    const b = data[0]!;
    assert.equal(b.attempts, 3);
    assert.equal(b.fail_rate, 0.67);
    assert.equal(b.low_sample, 3 < MIN_RELIABLE_ATTEMPTS);
    assert.deepEqual(b.misconceptions, [
      { points_to: "a", share: 0.67 },
      { points_to: "b", share: 0.33 },
    ]);
    assert.deepEqual(b.prerequisites, ["a"]);
  });

  it("reports the published prerequisites, not the course's", () => {
    const data = computePerformance(course, { a: [], b: [] }, [{ learner_id: 1, lesson_id: "b", answers: [0, 0] }]);
    assert.deepEqual(data[0]?.prerequisites, []);
  });
});
