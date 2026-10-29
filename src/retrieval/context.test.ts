import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courseFromSnapshot } from "../course/compile.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import { MemoryReleaseStore, planRelease, revert } from "../releases/release.js";
import { scenarioSnapshot } from "../simulation/index.js";
import { getScenario } from "../simulation/scenarios.js";
import { AUTHOR_CONTEXT_BUDGET, authorContext } from "./context.js";

const snapshot = scenarioSnapshot(getScenario("dominant-misconception"));
const input = {
  snapshot,
  course: courseFromSnapshot(snapshot),
  lessonId: "agent-loop",
  misconception: "model-executes-actions",
  evidence: { id: "model-executes-actions", points_to: "agent-loop", share: 0.63, confident: 0.8, covered: false },
  templates: ["contrast", "step_through"] as const,
  history: [],
};

describe("authorContext", () => {
  const text = authorContext({ ...input, templates: [...input.templates] });

  it("stays within its budget", () => {
    assert.ok(text.length <= AUTHOR_CONTEXT_BUDGET + 100, `${text.length} chars`);
  });

  it("states the belief, the evidence and the allowed templates", () => {
    assert.match(text, /The model carries out the actions it chooses/);
    assert.match(text, /63% of failed attempts; 80% .* high certainty/);
    assert.match(text, /Allowed templates: contrast, step_through/);
  });

  it("lists the quiz questions that reveal the belief, across lessons, as off limits", () => {
    for (const id of ["agent-loop-q2", "agent-loop-q6", "tool-calling-q1", "tool-calling-q5"]) assert.match(text, new RegExp(id));
    assert.match(text, /Do NOT reuse/);
  });

  it("gives section ids to attach to", () => {
    assert.match(text, /\[agent-loop\/the-harness-does-the-acting\]/);
  });

  it("remembers what was tried before and how its trial ended", () => {
    const store = new MemoryReleaseStore(snapshot);
    const plan = planRelease(store, [{ op: "add_block", section_id: "agent-loop/intro", intervention: EXEMPLARS[0]! }], "why");
    assert.ok(plan.ok);
    store.add(plan.candidate);
    revert(store, plan.candidate.version);
    const withHistory = authorContext({ ...input, templates: [...input.templates], history: store.all() });
    assert.match(withHistory, /1\.1\.0-trial\.1: contrast card for "model-executes-actions" → reverted/);
  });
});
