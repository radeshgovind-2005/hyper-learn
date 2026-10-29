import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileCourse } from "../course/compile.js";
import { getCourse } from "../course/bundle.js";
import { liveInterventions } from "../course/compile.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import { applyChange, applyChanges, type Change, invertChanges, riskTier, semverBump } from "./changes.js";
import { bumpVersion, MemoryReleaseStore, parseVersion, planRelease, promote, revert, trialVersion } from "./release.js";

const base = compileCourse(getCourse());
const lessonOf = (snapshot: typeof base, id: string) => snapshot.lessons.find((l) => l.id === id)!;
const now = () => "2026-10-29T00:00:00.000Z";

describe("changes", () => {
  it("applies to a copy, never the original", () => {
    const next = applyChange(base, { op: "remove_prerequisite", lesson: "multi-agent", prerequisite: "tool-calling" });
    assert.deepEqual(lessonOf(next, "multi-agent").prerequisites, ["structured-output"]);
    assert.deepEqual(lessonOf(base, "multi-agent").prerequisites, ["tool-calling", "structured-output"]);
  });

  it("archives and restores lessons, sections and blocks", () => {
    const next = applyChange(base, { op: "archive_node", node_id: "agent-loop/stopping/p1" });
    assert.equal(lessonOf(next, "agent-loop").sections[3]!.blocks[0]!.archived, true);
    assert.throws(() => applyChange(next, { op: "archive_node", node_id: "agent-loop/stopping/p1" }), /already archived/);
    assert.throws(() => applyChange(base, { op: "archive_node", node_id: "nope" }), /no lesson, section or block/);
  });

  it("rejects changes that don't fit the snapshot", () => {
    assert.throws(() => applyChange(base, { op: "add_prerequisite", lesson: "multi-agent", prerequisite: "tool-calling" }), /already a prerequisite/);
    assert.throws(() => applyChange(base, { op: "remove_prerequisite", lesson: "llm-basics", prerequisite: "agent-loop" }), /not a prerequisite/);
    assert.throws(() => applyChange(base, { op: "add_prerequisite", lesson: "zzz", prerequisite: "agent-loop" }), /no lesson "zzz"/);
  });

  it("inverts any changeset exactly, including prerequisite order", () => {
    const changes: Change[] = [
      { op: "remove_prerequisite", lesson: "multi-agent", prerequisite: "tool-calling" },
      { op: "archive_node", node_id: "reflection" },
      { op: "archive_node", node_id: "agent-loop/intro" },
      { op: "add_prerequisite", lesson: "reflection", prerequisite: "llm-basics" },
    ];
    const after = applyChanges(base, changes);
    assert.deepEqual(applyChanges(after, invertChanges(base, changes)), base);
  });

  it("adds an intervention block with an id code assigns, and removes it exactly on revert", () => {
    const add: Change = { op: "add_block", section_id: "agent-loop/the-harness-does-the-acting", intervention: EXEMPLARS[0]! };
    const next = applyChanges(base, [add, add]);
    assert.deepEqual(
      liveInterventions(next).map((i) => i.block_id),
      ["agent-loop/the-harness-does-the-acting/i1", "agent-loop/the-harness-does-the-acting/i2"],
    );
    assert.deepEqual(applyChanges(next, invertChanges(base, [add, add])), base);
    assert.throws(() => applyChange(base, { ...add, section_id: "agent-loop" }), /not a section/);
  });

  it("rates an intervention R0 and a minor bump", () => {
    const add: Change = { op: "add_block", section_id: "agent-loop/intro", intervention: EXEMPLARS[0]! };
    assert.equal(riskTier(base, add), "R0");
    assert.equal(semverBump(base, add), "minor");
  });

  it("assigns risk and semver in code", () => {
    const edge: Change = { op: "add_prerequisite", lesson: "reflection", prerequisite: "llm-basics" };
    assert.equal(riskTier(base, edge), "R1");
    assert.equal(semverBump(base, edge), "major");
    assert.equal(riskTier(base, { op: "archive_node", node_id: "reflection" }), "R2");
    assert.equal(riskTier(base, { op: "archive_node", node_id: "reflection/intro/p1" }), "R1");
    assert.equal(semverBump(base, { op: "archive_node", node_id: "reflection/intro/p1" }), "minor");
  });
});

describe("versions", () => {
  it("bumps and numbers trials", () => {
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(trialVersion("2.0.0", ["1.0.0", "2.0.0-trial.1"]), "2.0.0-trial.2");
    assert.equal(parseVersion("2.0.0-trial.3").trial, 3);
    assert.throws(() => parseVersion("v2"), /Invalid version/);
  });
});

describe("planRelease, promote, revert", () => {
  const edge: Change = { op: "add_prerequisite", lesson: "reflection", prerequisite: "llm-basics" };

  it("builds a validated candidate on top of the live release", () => {
    const store = new MemoryReleaseStore(base, now);
    const plan = planRelease(store, [edge], "why", now);
    assert.ok(plan.ok);
    assert.equal(plan.candidate.version, "2.0.0-trial.1");
    assert.equal(plan.candidate.parent, "1.0.0");
    assert.equal(plan.candidate.tier, "R1");
    assert.equal(plan.candidate.snapshot.version, "2.0.0-trial.1");
    assert.deepEqual(applyChanges(plan.candidate.snapshot, plan.candidate.inverse).lessons, base.lessons);
    assert.equal(store.all().length, 1, "planning doesn't store anything");
  });

  it("refuses a candidate that breaks a course invariant", () => {
    const store = new MemoryReleaseStore(base, now);
    const plan = planRelease(store, [{ op: "add_prerequisite", lesson: "llm-basics", prerequisite: "reflection" }], "why", now);
    assert.equal(plan.ok, false);
    assert.match(!plan.ok ? plan.problems.join() : "", /cycle/);
    const removal = planRelease(store, [{ op: "remove_prerequisite", lesson: "llm-basics", prerequisite: "x" }], "why", now);
    assert.match(!removal.ok ? removal.problems.join() : "", /not a prerequisite/);
    assert.match(!planRelease(store, [], "why").ok ? "empty" : "", /empty/);
  });

  it("promotes a trial to the next release, superseding the old one", () => {
    const store = new MemoryReleaseStore(base, now);
    const plan = planRelease(store, [edge], "why", now);
    assert.ok(plan.ok);
    store.add(plan.candidate);
    const released = promote(store, plan.candidate.version);
    assert.equal(released.version, "2.0.0");
    assert.equal(store.live().version, "2.0.0");
    assert.equal(store.get("1.0.0")?.status, "superseded");
    assert.equal(store.get("2.0.0-trial.1")?.promoted_to, "2.0.0");
    assert.equal(store.live().released_from, "2.0.0-trial.1");
  });

  it("reverts a trial without touching the live release, and numbers the next trial after it", () => {
    const store = new MemoryReleaseStore(base, now);
    const first = planRelease(store, [edge], "why", now);
    assert.ok(first.ok);
    store.add(first.candidate);
    revert(store, first.candidate.version);
    assert.equal(store.live().version, "1.0.0");
    assert.equal(store.get("2.0.0-trial.1")?.status, "reverted");
    const second = planRelease(store, [edge], "again", now);
    assert.equal(second.ok && second.candidate.version, "2.0.0-trial.2");
    assert.throws(() => revert(store, "2.0.0-trial.1"), /not a running trial/);
  });
});
