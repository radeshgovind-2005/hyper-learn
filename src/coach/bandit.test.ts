import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coursePermissions } from "../app/access.js";
import { seededRandom } from "../simulation/random.js";
import { beta, chooseApproach, MIN_SAMPLES } from "./bandit.js";
import type { Target } from "./diagnose.js";
import { PROMOTE_AFTER, promotionFor, promotionRequest } from "./promote.js";
import { approachFor } from "./repair.js";

const target: Target = { kind: "objective", id: "l1-o1", lesson: "l1", why: "x" };

describe("bandit: choosing a personal lesson's approach by outcomes", () => {
  it("uses the fixed order until there are enough outcomes", () => {
    const few = [{ approach: "smaller_steps", shown: MIN_SAMPLES - 1, fixed: MIN_SAMPLES - 1 }];
    assert.deepEqual(chooseApproach(target, 0, few), { approach: approachFor(target, 0), by: "order" });
    assert.deepEqual(chooseApproach(target, 1, []), { approach: approachFor(target, 1), by: "order" });
  });

  it("picks what fixed 8 of 10 over what fixed 2 of 10 most of the time, and still explores", () => {
    const random = seededRandom(42);
    const counts = [
      { approach: "worked_example", shown: 10, fixed: 8 },
      { approach: "refute", shown: 10, fixed: 2 },
    ];
    const picks = { refute: 0, worked_example: 0, smaller_steps: 0 };
    for (let i = 0; i < 1_000; i++) picks[chooseApproach(target, 0, counts, random).approach]++;
    assert.ok(picks.worked_example > 700, `worked_example ${picks.worked_example} of 1000`);
    assert.ok(picks.worked_example < 1_000, "the others are still tried sometimes");
    assert.ok(picks.refute + picks.smaller_steps > 0);
  });

  it("draws Beta samples with the right mean", () => {
    const random = seededRandom(7);
    let sum = 0;
    for (let i = 0; i < 4_000; i++) sum += beta(9, 3, random);
    assert.ok(Math.abs(sum / 4_000 - 0.75) < 0.02);
  });
});

describe("promotion: from one learner's fix to the course", () => {
  const snapshot = {
    course_id: "c",
    title: "C",
    version: "1.0.0",
    misconceptions: [],
    objectives: [{ id: "l1-o1", lesson: "l1", statement: "Explain X", sections: ["l1/x"] }],
    lessons: [{ id: "l1", title: "L1", summary: "", prerequisites: [], quiz: [], archived: false, sections: [{ id: "l1/x", title: "X", blocks: [], archived: false }] }],
  };

  it(`needs ${PROMOTE_AFTER} learners fixed by one approach, and becomes a tune request for the target's section`, () => {
    assert.equal(promotionFor(snapshot, target, [{ approach: "worked_example", shown: 5, fixed: PROMOTE_AFTER - 1 }]), null);
    const promotion = promotionFor(snapshot, target, [
      { approach: "worked_example", shown: 4, fixed: PROMOTE_AFTER },
      { approach: "refute", shown: 9, fixed: 1 },
    ]);
    assert.deepEqual(promotion, { approach: "worked_example", fixed: 3, shown: 4, section_id: "l1/x" });
    const request = promotionRequest("Explain X", promotion!);
    assert.equal(request.kind, "tune");
    assert.equal(request.kind === "tune" && request.preset, "worked_example");
    assert.match(request.kind === "tune" ? request.instruction! : "", /3 of 4 learners/);
  });

  it("is for people who may repair the course, not learners", () => {
    assert.ok(!coursePermissions({ featured: false, global: "learner", course: "learner" }).includes("repair"));
    assert.ok(coursePermissions({ featured: false, global: "learner", course: "editor" }).includes("repair"));
  });
});
