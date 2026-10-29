import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse } from "../assessment/answers.js";
import { getCourse } from "../course/bundle.js";
import { compileCourse } from "../course/compile.js";
import type { LearnerEvent } from "../storage/sql.js";
import { armOf, attemptsFrom, realPerformance } from "./real.js";

const lesson = getCourse().getLesson("agent-loop")!;
const right = lesson.quiz.map((item) => correctResponse(item));

const answer = (learner: string, at: string, attempt?: number): LearnerEvent => ({
  learner,
  kind: "answer",
  lesson: lesson.id,
  release: "1.0.0",
  data: { responses: right, certainty: right.map(() => 3), ...(attempt && { attempt }) },
  at,
});

describe("real learners", () => {
  it("assigns each learner a stable arm, about half to each", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `user_${i}`);
    assert.ok(ids.every((id) => armOf(id, "1.1.0-trial.1") === armOf(id, "1.1.0-trial.1")));
    const treated = ids.filter((id) => armOf(id, "1.1.0-trial.1") === "treatment").length;
    assert.ok(treated > 900 && treated < 1100, `${treated} of 2000 in treatment`);
    // A new trial reshuffles: the same people aren't always the ones trying changes.
    const moved = ids.filter((id) => armOf(id, "1.1.0-trial.1") !== armOf(id, "1.2.0-trial.1")).length;
    assert.ok(moved > 900 && moved < 1100);
  });

  it("numbers attempts per learner and lesson, preferring the number recorded at the time", () => {
    const events = [answer("a", "t1"), answer("b", "t2"), answer("a", "t3"), answer("c", "t4", 3)];
    assert.deepEqual(
      attemptsFrom(events).map((a) => [a.learner, a.attempt]),
      [["a", 1], ["b", 1], ["a", 2], ["c", 3]],
    );
  });

  it("diagnoses from first attempts only, and a handful of learners is low_sample", () => {
    const snapshot = compileCourse(getCourse());
    const few = realPerformance(snapshot, "1.0.0", [answer("a", "t1"), answer("a", "t2")]);
    const node = few.find((n) => n.node_id === lesson.id)!;
    assert.equal(node.attempts, 1);
    assert.equal(node.low_sample, true);
  });
});
