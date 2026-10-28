import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMutation } from "./mutations.js";
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
  reason: "",
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

  it("rejects self-loops, duplicate edges, cycles and removing missing edges", () => {
    assert.match(checkMutation(m("add_prerequisite", "b", "b"), DATA).join(), /must differ/);
    assert.match(checkMutation(m("add_prerequisite", "b", "a"), DATA).join(), /already a prerequisite/);
    assert.match(checkMutation(m("add_prerequisite", "a", "c"), DATA).join(), /would create a cycle/);
    assert.match(checkMutation(m("remove_prerequisite", "c", "a"), DATA).join(), /not a prerequisite/);
  });
});
