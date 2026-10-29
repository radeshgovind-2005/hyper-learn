import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Grade } from "../assessment/grade.js";
import type { LiveIntervention } from "../course/compile.js";
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
