import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCourse } from "../course/load.js";
import type { NodePerformance } from "../state.js";
import { scenarioPerformance } from "./index.js";
import { publishedGraph, simulate } from "./learners.js";
import { getScenario, SCENARIOS } from "./scenarios.js";

const byId = (data: NodePerformance[], id: string) => {
  const node = data.find((n) => n.node_id === id);
  assert.ok(node, `no data for ${id}`);
  return node;
};

describe("simulation", () => {
  it("is deterministic: the same seed gives identical attempts", () => {
    const scenario = getScenario("missing-prereq");
    assert.deepEqual(simulate(getCourse(), scenario), simulate(getCourse(), scenario));
  });

  it("changes with the seed", () => {
    const scenario = getScenario("control");
    assert.notDeepEqual(simulate(getCourse(), scenario, { seed: 1 }), simulate(getCourse(), scenario, { seed: 2 }));
  });

  it("refuses to remove an edge that doesn't exist", () => {
    const typo = { ...getScenario("control"), removeEdges: [["multi-agent", "reflection"]] as const };
    assert.throws(() => publishedGraph(getCourse(), typo), /no edge reflection → multi-agent/);
  });

  it("control: no reliable lesson fails 35% or more", () => {
    for (const node of scenarioPerformance(getScenario("control"))) {
      assert.ok(node.fail_rate < 0.35, `${node.node_id} fails ${node.fail_rate}`);
    }
  });

  it("missing-prereq: multi-agent fails, mostly with answers revealing a tool-calling gap", () => {
    const data = scenarioPerformance(getScenario("missing-prereq"));
    const multiAgent = byId(data, "multi-agent");
    assert.deepEqual(multiAgent.prerequisites, ["structured-output"], "the edge is missing from the published graph");
    assert.ok(multiAgent.fail_rate >= 0.35);
    assert.equal(multiAgent.misconceptions[0]?.points_to, "tool-calling");
  });

  it("overloaded: agent-loop fails with gaps inside itself, and its dependents point back at it", () => {
    const data = scenarioPerformance(getScenario("overloaded"));
    assert.equal(byId(data, "agent-loop").misconceptions[0]?.points_to, "agent-loop");
    assert.equal(byId(data, "tool-calling").misconceptions[0]?.points_to, "agent-loop");
    assert.ok(byId(data, "agent-loop").fail_rate >= 0.35);
  });

  it("low-sample-trap: reflection has 10 attempts and is flagged low_sample", () => {
    const reflection = byId(scenarioPerformance(getScenario("low-sample-trap")), "reflection");
    assert.equal(reflection.attempts, 10);
    assert.equal(reflection.low_sample, true);
  });

  it("every scenario has a unique id", () => {
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  });
});
