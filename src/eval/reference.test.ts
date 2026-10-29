import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAgent } from "../agents.js";
import { checkMutation } from "../mutations.js";
import { scenarioPerformance } from "../simulation/index.js";
import { SCENARIOS } from "../simulation/scenarios.js";
import { DOMINANT_SHARE, PROBLEM_FAIL_RATE, referenceCurator } from "./reference.js";
import { scoreMutation } from "./score.js";

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

describe("reference curator (scenario solvability)", () => {
  for (const scenario of SCENARIOS) {
    it(`solves "${scenario.id}" exactly, for its own seed and ${SEEDS.length} others`, () => {
      for (const seed of [scenario.seed, ...SEEDS]) {
        const data = scenarioPerformance(scenario, seed);
        const mutation = referenceCurator(data);
        assert.equal(scoreMutation(scenario.expected, mutation), "exact", `seed ${seed}: ${JSON.stringify(mutation)}`);
        assert.deepEqual(checkMutation(mutation, data), [], "its answers pass the code checks");
      }
    });
  }

  it("uses the same problem threshold as the Curator's instructions", () => {
    const instructions = getAgent("curator").instructions.join(" ");
    assert.ok(instructions.includes(`${PROBLEM_FAIL_RATE} or more`), "update agents.json if PROBLEM_FAIL_RATE changes");
    assert.ok(instructions.includes(`share ${DOMINANT_SHARE} or more`), "update agents.json if DOMINANT_SHARE changes");
  });
});

describe("scoreMutation", () => {
  const expected = { action: "add_prerequisite", node_id: "b", target_node_id: "a", misconception_id: null } as const;
  const base = { reason: "", misconception_id: null };

  it("scores exact, right_lesson and miss", () => {
    assert.equal(scoreMutation(expected, { ...base, action: "add_prerequisite", node_id: "b", target_node_id: "a" }), "exact");
    assert.equal(scoreMutation(expected, { ...base, action: "split_node", node_id: "b", target_node_id: null }), "right_lesson");
    assert.equal(scoreMutation(expected, { ...base, action: "add_prerequisite", node_id: "c", target_node_id: "a" }), "miss");
    assert.equal(scoreMutation(expected, undefined), "miss");
  });

  it("accepts any lesson when the expected node is null", () => {
    const control = { action: "flag_for_review", node_id: null, target_node_id: null, misconception_id: null } as const;
    assert.equal(scoreMutation(control, { ...base, action: "flag_for_review", node_id: "x", target_node_id: null }), "exact");
  });
});
