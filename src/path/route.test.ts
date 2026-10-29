import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Grade } from "../assessment/grade.js";
import { gradeItem } from "../assessment/grade.js";
import { correctResponse } from "../assessment/answers.js";
import { type LiveIntervention, liveObjectives } from "../course/compile.js";
import { STUDIO_OBJECTIVES, studioSnapshot } from "../course/fixtures/studio-course.js";
import type { Objective } from "../course/schema.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import { nextSteps } from "./route.js";

const contrast = EXEMPLARS.find((e) => e.template === "contrast")!;
const live: LiveIntervention[] = [
  { block_id: "agent-loop/the-harness-does-the-acting/i1", lesson: "agent-loop", section: "agent-loop/the-harness-does-the-acting", intervention: contrast },
];
const wrong = (points_to: string, misconception?: string): Grade => ({
  score: 0,
  correct: false,
  errors: [{ points_to, ...(misconception && { misconception }) }],
});

describe("nextSteps", () => {
  it("continues after a pass", () => {
    assert.deepEqual(nextSteps("agent-loop", [], true, live), [{ kind: "continue", lesson: "agent-loop" }]);
  });

  it("shows the intervention for a misconception the learner showed, then a retake", () => {
    const steps = nextSteps("agent-loop", [wrong("agent-loop", "model-executes-actions")], false, live);
    assert.deepEqual(
      steps.map((s) => s.kind),
      ["intervention", "retake"],
    );
    assert.equal(steps[0]?.kind === "intervention" && steps[0].block_id, live[0]!.block_id);
  });

  it("sends a learner to an intervention in an earlier lesson when their belief belongs there", () => {
    const steps = nextSteps("tool-calling", [wrong("agent-loop", "model-executes-actions")], false, live);
    assert.deepEqual(steps.map((s) => [s.kind, s.lesson]), [["intervention", "agent-loop"], ["retake", "tool-calling"]]);
  });

  it("reviews a prerequisite gap that no intervention covers", () => {
    const steps = nextSteps("multi-agent", [wrong("tool-calling")], false, live);
    assert.deepEqual(steps.map((s) => [s.kind, s.lesson]), [["review", "tool-calling"], ["retake", "multi-agent"]]);
  });

  it("only retakes when nothing applies", () => {
    assert.deepEqual(nextSteps("agent-loop", [wrong("agent-loop")], false, []), [{ kind: "retake", lesson: "agent-loop" }]);
  });
});

describe("nextSteps with objectives", () => {
  const missed = (points_to: string, objective: string, misconception?: string): Grade => ({ ...wrong(points_to, misconception), objective });
  const right = (objective: string): Grade => ({ score: 1, correct: true, errors: [], objective });

  it("sends the learner to the first section of each objective they missed, after interventions and before prerequisite reviews", () => {
    const steps = nextSteps(
      "eviction",
      [missed("cache-hits", "apply-lru"), right("judge-cache-size"), missed("eviction", "judge-cache-size", "model-executes-actions")],
      false,
      live,
      STUDIO_OBJECTIVES,
    );
    assert.deepEqual(
      steps.map((s) => [s.kind, s.kind === "review_section" ? s.section_id : s.lesson]),
      [
        ["intervention", "agent-loop"],
        ["review_section", "eviction/lru"],
        ["review_section", "eviction/sizing"],
        ["review", "cache-hits"],
        ["retake", "eviction"],
      ],
    );
    const review = steps[1]!;
    assert.ok(review.kind === "review_section");
    assert.equal(review.objective, "apply-lru");
    assert.equal(review.reason, 'missed "Pick the entry an LRU cache evicts"');
  });

  it("suggests a section once even when two missed objectives start there, and skips objectives without sections", () => {
    const objectives: Objective[] = [
      { id: "a", lesson: "l", statement: "A", sections: ["l/s1", "l/s2"] },
      { id: "b", lesson: "l", statement: "B", sections: ["l/s1"] },
      { id: "c", lesson: "l", statement: "C", sections: [] },
    ];
    const steps = nextSteps("l", [missed("l", "a"), missed("l", "b"), missed("l", "c")], false, [], objectives);
    assert.deepEqual(steps.map((s) => s.kind), ["review_section", "retake"]);
  });

  it("adds nothing for objectives answered right, or after a pass", () => {
    assert.deepEqual(nextSteps("l", [right("apply-lru")], false, [], STUDIO_OBJECTIVES).map((s) => s.kind), ["retake"]);
    assert.deepEqual(nextSteps("l", [missed("l", "apply-lru")], true, [], STUDIO_OBJECTIVES).map((s) => s.kind), ["continue"]);
  });

  it("gets the objective from the graded item", () => {
    const item = studioSnapshot().lessons[0]!.quiz[0]!;
    assert.equal(gradeItem(item, correctResponse(item), "cache-hits").objective, "tell-hit-from-miss");
  });

  it("is given only live sections of live lessons", () => {
    const snapshot = studioSnapshot();
    snapshot.lessons[1]!.sections[0]!.archived = true; // eviction/lru
    snapshot.lessons[2]!.archived = true;
    const objectives = liveObjectives(snapshot);
    assert.deepEqual(objectives.map((o) => o.id), ["tell-hit-from-miss", "compute-hit-ratio", "apply-lru", "judge-cache-size"]);
    assert.deepEqual(objectives.find((o) => o.id === "apply-lru")!.sections, []);
  });
});
