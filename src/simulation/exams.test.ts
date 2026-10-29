import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePerformance } from "../analytics/performance.js";
import { courseFromSnapshot } from "../course/compile.js";
import { getCourse } from "../course/bundle.js";
import { STUDIO_CONTROL, STUDIO_MISSING_PREREQ, studioSnapshot } from "../course/fixtures/studio-course.js";
import { referenceCurator } from "../eval/reference.js";
import { scoreMutation } from "../eval/score.js";
import { DEFAULT_LEARNER_MODEL, simulate } from "./learners.js";
import { getScenario } from "./scenarios.js";

const course = courseFromSnapshot(studioSnapshot());
const model = { ...DEFAULT_LEARNER_MODEL, learners: 120 };

describe("simulated learners on a course with drawn exams", () => {
  const { attempts } = simulate(course, STUDIO_MISSING_PREREQ, { model, retakes: true });

  it("draws each attempt's items and records them", () => {
    for (const a of attempts) {
      const lesson = course.getLesson(a.lesson_id)!;
      // One scored item per objective (two per lesson), plus the pilot item in cache-hits.
      assert.equal(a.item_ids?.length, lesson.id === "cache-hits" ? 3 : 2);
      assert.equal(a.answers.length, a.item_ids!.length);
    }
  });

  it("draws a retake again, from items the learner hasn't seen", () => {
    const retakes = attempts.filter((a) => a.attempt === 2);
    assert.ok(retakes.length > 10, `${retakes.length} retakes`);
    for (const retake of retakes) {
      const first = attempts.find((a) => a.learner_id === retake.learner_id && a.lesson_id === retake.lesson_id && a.attempt === 1)!;
      const scored = (ids: string[]) => ids.filter((id) => !course.getLesson(retake.lesson_id)!.quiz.find((q) => q.id === id)!.pilot);
      assert.equal(scored(retake.item_ids!).filter((id) => first.item_ids!.includes(id)).length, 0);
    }
  });

  it("is deterministic for a seed", () => {
    assert.deepEqual(simulate(course, STUDIO_MISSING_PREREQ, { model, retakes: true }).attempts, attempts);
  });

  it("leaves lessons without an exam config as they were: the whole quiz, no item_ids", () => {
    const featured = simulate(getCourse(), getScenario("control"), { model: { ...model, learners: 5 } }).attempts;
    assert.ok(featured.every((a) => a.item_ids === undefined && a.answers.length === getCourse().getLesson(a.lesson_id)!.quiz.length));
  });

  for (const scenario of [STUDIO_MISSING_PREREQ, STUDIO_CONTROL]) {
    it(`gives data the reference Curator solves: ${scenario.id}`, () => {
      for (const seed of [scenario.seed, 1, 2, 3, 4, 5]) {
        const { published, attempts: sample } = simulate(course, scenario, { seed });
        const mutation = referenceCurator(computePerformance(course, published, sample));
        assert.equal(scoreMutation(scenario.expected, mutation), "exact", `seed ${seed}: ${JSON.stringify(mutation)}`);
      }
    });
  }
});
