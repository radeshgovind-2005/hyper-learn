import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMutation, citesRate } from "./mutations.js";
import type { Mutation, NodePerformance } from "./state.js";

const node = (node_id: string, prerequisites: string[]): NodePerformance => ({
  node_id,
  title: node_id,
  attempts: 100,
  fail_rate: 0.5,
  fail_rate_ci: [0.4, 0.6],
  low_sample: false,
  prerequisites,
  misconceptions: [],
});
const DATA = [node("a", []), node("b", ["a"]), node("c", ["b"])];
const m = (action: Mutation["action"], node_id: string, target_node_id: string | null): Mutation => ({
  action,
  node_id,
  target_node_id,
  reason: `${node_id} fails 0.5 of attempts`,
});

describe("checkMutation", () => {
  it("accepts valid mutations", () => {
    assert.deepEqual(checkMutation(m("split_node", "b", null), DATA), []);
    assert.deepEqual(checkMutation(m("add_prerequisite", "c", "a"), DATA), []);
    assert.deepEqual(checkMutation(m("remove_prerequisite", "b", "a"), DATA), []);
  });

  it("rejects unknown ids", () => {
    assert.match(checkMutation(m("split_node", "zzz", null), DATA).join(), /"zzz" is not a lesson/);
    assert.match(checkMutation(m("add_prerequisite", "c", "zzz"), DATA).join(), /target_node_id "zzz"/);
  });

  it("requires a target exactly when the action needs one", () => {
    assert.match(checkMutation(m("add_prerequisite", "c", null), DATA).join(), /needs a target_node_id/);
    assert.match(checkMutation(m("split_node", "c", "a"), DATA).join(), /must have target_node_id = null/);
  });

  it("rejects a reason that doesn't cite the target's fail rate", () => {
    const vague = { ...m("split_node", "b", null), reason: "Root cause upstream of the failing chain." };
    assert.match(checkMutation(vague, DATA).join(), /reason must cite b's fail_rate from the data \(0\.5\)/);
  });

  it("rejects self-loops, duplicate edges, cycles and removing missing edges", () => {
    assert.match(checkMutation(m("add_prerequisite", "b", "b"), DATA).join(), /must differ/);
    assert.match(checkMutation(m("add_prerequisite", "b", "a"), DATA).join(), /already a prerequisite/);
    assert.match(checkMutation(m("add_prerequisite", "a", "c"), DATA).join(), /would create a cycle/);
    assert.match(checkMutation(m("remove_prerequisite", "c", "a"), DATA).join(), /not a prerequisite/);
  });
});

describe("citesRate", () => {
  it("accepts the rate as a decimal or a percentage", () => {
    for (const text of ["fail_rate 0.6", "fails 0.60 of the time", "60% fail", "60 % fail", "(0.6)"]) {
      assert.ok(citesRate(text, 0.6), text);
    }
  });

  it("doesn't count a longer number that starts or ends the same way", () => {
    for (const text of ["fail_rate 0.65", "0.6123", "160%", "10.6"]) {
      assert.equal(citesRate(text, 0.6), false, text);
    }
    assert.equal(citesRate("fail_rate 0.5", 0), false, "a rate of 0 must not match inside 0.5");
    assert.ok(citesRate("fail_rate 0 everywhere", 0));
  });
});
