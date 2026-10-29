import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCourse } from "../course/load.js";
import { MemoryReleaseStore, planRelease, type Release } from "../releases/release.js";
import type { Change } from "../releases/changes.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import { scenarioSnapshot } from "../simulation/index.js";
import { getScenario } from "../simulation/scenarios.js";
import { compare, type Comparison, decideTrial, differenceInterval, type Measurement, outcome } from "./decide.js";
import { SimMeasurer } from "./measure.js";

describe("differenceInterval", () => {
  it("brackets the observed difference", () => {
    const [low, high] = differenceInterval(outcome(100, 50), outcome(100, 30));
    assert.ok(low < -0.2 && -0.2 < high);
    assert.ok(high < 0, "a 20-point drop on 100 per arm is significant");
  });

  it("includes 0 for a small difference on small arms", () => {
    const [low, high] = differenceInterval(outcome(40, 20), outcome(40, 17));
    assert.ok(low < 0 && high > 0);
  });
});

const comparison = (control: [number, number], treatment: [number, number], lesson = "a"): Comparison =>
  compare(lesson, "fail_rate", outcome(...control), outcome(...treatment));
const measurement = (expectation: Measurement["expectation"], primary: Comparison, guardrails: Comparison[] = []): Measurement => ({
  source: "simulation",
  expectation,
  primary,
  guardrails,
});

describe("decideTrial", () => {
  it("keeps a confident improvement of at least the minimum effect", () => {
    assert.equal(decideTrial(measurement("improve", comparison([200, 100], [200, 40]))).verdict, "keep");
  });

  it("reverts an improvement that is too small or uncertain", () => {
    assert.equal(decideTrial(measurement("improve", comparison([200, 100], [200, 90]))).verdict, "revert");
    assert.equal(decideTrial(measurement("improve", comparison([40, 20], [40, 15]))).verdict, "revert");
  });

  it("reverts when a guardrail lesson regresses, and says why", () => {
    const decision = decideTrial(measurement("improve", comparison([200, 100], [200, 40]), [comparison([200, 20], [200, 60], "b")]));
    assert.equal(decision.verdict, "revert");
    assert.match(decision.reasons.join(), /guardrail regressed: b fail rate/);
  });

  it("keeps a no-harm change only if its worst case stays under the margin", () => {
    assert.equal(decideTrial(measurement("no_harm", comparison([300, 30], [300, 28]))).verdict, "keep");
    assert.equal(decideTrial(measurement("no_harm", comparison([300, 30], [300, 60]))).verdict, "revert");
  });

  it("concludes nothing from too few attempts", () => {
    assert.match(decideTrial(measurement("improve", comparison([10, 8], [10, 1]))).reasons.join(), /too few attempts/);
  });
});

describe("SimMeasurer", () => {
  const trial = (scenarioId: string, change: Change) => {
    const scenario = getScenario(scenarioId);
    const store = new MemoryReleaseStore(scenarioSnapshot(scenario));
    const plan = planRelease(store, [change], "test");
    assert.ok(plan.ok, !plan.ok ? plan.problems.join() : "");
    return { live: store.live(), candidate: plan.candidate as Release, measurer: new SimMeasurer(getCourse(), scenario) };
  };

  it("keeps the missing prerequisite once it's added back", async () => {
    const { live, candidate, measurer } = trial("missing-prereq", { op: "add_prerequisite", lesson: "multi-agent", prerequisite: "tool-calling" });
    const m = await measurer.measure(live, candidate);
    assert.equal(m.primary.lesson, "multi-agent");
    assert.equal(decideTrial(m).verdict, "keep", decideTrial(m).reasons.join());
  });

  it("reverts removing a real prerequisite", async () => {
    const { live, candidate, measurer } = trial("harmful-edge", { op: "remove_prerequisite", lesson: "tool-calling", prerequisite: "agent-loop" });
    assert.equal(decideTrial(await measurer.measure(live, candidate)).verdict, "revert");
  });

  it("reverts a prerequisite that changes nothing", async () => {
    const { live, candidate, measurer } = trial("control", { op: "add_prerequisite", lesson: "reflection", prerequisite: "llm-basics" });
    const decision = decideTrial(await measurer.measure(live, candidate));
    assert.equal(decision.verdict, "revert");
    assert.match(decision.reasons[0]!, /no confident improvement/);
  });

  it("keeps an intervention that clears the belief, measured on retakes", async () => {
    const add: Change = { op: "add_block", section_id: "agent-loop/the-harness-does-the-acting", intervention: EXEMPLARS[0]! };
    const { live, candidate, measurer } = trial("dominant-misconception", add);
    const m = await measurer.measure(live, candidate);
    assert.equal(m.primary.metric, "misconception_rate");
    assert.equal(m.primary.misconception, "model-executes-actions");
    assert.ok(m.primary.control.attempts >= 30);
    assert.equal(decideTrial(m).verdict, "keep", decideTrial(m).reasons.join());
  });

  it("reverts an intervention that changes no one's mind", async () => {
    const add: Change = { op: "add_block", section_id: "agent-loop/the-harness-does-the-acting", intervention: EXEMPLARS[0]! };
    const { live, candidate, measurer } = trial("ineffective-fix", add);
    assert.equal(decideTrial(await measurer.measure(live, candidate)).verdict, "revert");
  });

  it("uses a different seed from the diagnosis", async () => {
    const { live, candidate, measurer } = trial("missing-prereq", { op: "add_prerequisite", lesson: "multi-agent", prerequisite: "tool-calling" });
    assert.notEqual((await measurer.measure(live, candidate)).seed, getScenario("missing-prereq").seed);
  });
});
