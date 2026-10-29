import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AIMessageChunk } from "@langchain/core/messages";
import { buildGraph } from "../graph.js";
import type { Mutation, NodePerformance, ReflectionVerdict } from "../state.js";
import { runAgents } from "./agents.js";

const data: NodePerformance[] = [
  {
    node_id: "a",
    title: "A",
    attempts: 200,
    fail_rate: 0.6,
    fail_rate_ci: [0.53, 0.67],
    low_sample: false,
    prerequisites: [],
    gaps: [{ points_to: "a", share: 0.9 }],
    misconceptions: [],
    mastery_rate: 0.3,
    excluded_items: [],
  },
];
const expected = { action: "split_node", node_id: "a", target_node_id: null, misconception_id: null } as const;
const proposal: Mutation = { ...expected, reason: "a fails 0.6; 90% of wrong answers are inside it" };

const fake = <T>(respond: () => T) => ({ invoke: async () => respond() });
const graphWith = (reflect: () => ReflectionVerdict) =>
  buildGraph({
    curator: fake(() => proposal),
    reflection: fake(reflect),
    assistant: fake<AIMessageChunk>(() => {
      throw new Error("assistant must not run");
    }),
  });

describe("runAgents", () => {
  it("scores an approved proposal", async () => {
    const result = await runAgents(expected, data, graphWith(() => ({ approved: true, critique: "ok" })));
    assert.equal(result.score, "exact");
    assert.equal(result.proposal_score, "exact");
    assert.equal(result.approved, true);
    assert.equal(result.error, undefined);
  });

  it("keeps the Curator's proposal when Reflection fails", async () => {
    const result = await runAgents(
      expected,
      data,
      graphWith(() => {
        throw new Error("Could not parse response content as the length limit was reached");
      }),
    );
    assert.deepEqual(result.proposal, proposal, "the proposal survives the failure");
    assert.equal(result.proposal_score, "exact");
    assert.equal(result.score, "miss", "nothing was approved, so nothing would be applied");
    assert.equal(result.approved, false);
    assert.match(result.error ?? "", /length limit/);
  });
});
