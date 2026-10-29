import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import type { Certainty, Response } from "../assessment/items.js";
import { getCourse } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { CourseService } from "./service.js";

const lesson = getCourse().getLesson("agent-loop")!;
let ids = 0;
const service = (sql = sqlite()) => new CourseService(sql, { now: () => "2026-10-29T12:00:00.000Z", newId: () => `run-${++ids}` });

/** Answers that show "the model runs the actions" wherever an item can, and are right elsewhere. */
function believerAnswers(): { answers: Response[]; certainty: Certainty[] } {
  const answers = lesson.quiz.map(
    (item) => wrongOptions(item, lesson.id).find((o) => o.reveals.misconception === "model-executes-actions")?.response ?? correctResponse(item),
  );
  return { answers, certainty: answers.map(() => 3 as const) };
}

describe("CourseService", () => {
  it("starts from the default scenario's v1.0.0", () => {
    const s = service();
    const overview = s.overview();
    assert.equal(overview.scenario, "dominant-misconception");
    assert.deepEqual(overview.releases.map((r) => r.version), ["1.0.0"]);
    assert.equal(overview.agentsAvailable, false);
  });

  it("runs the loop, pauses for a human, and releases a kept intervention", async () => {
    const s = service();
    const updates: string[] = [];
    const paused = await s.startRun({ mode: "hitl", agents: false }, (run) => updates.push(run.status));
    assert.equal(paused.status, "awaiting_approval");
    assert.equal(paused.approval?.version, "1.1.0-trial.1");
    assert.deepEqual(
      paused.steps.map((step) => step.node),
      ["curator", "reflection", "author", "review_content", "plan_release", "approve"],
    );
    assert.ok(updates.length >= 5, "the UI is updated as each step happens");

    const done = await s.approve({ approved: true, note: "looks right" });
    assert.equal(done.status, "done");
    assert.match(done.steps.at(-1)!.title, /Kept: 1.1.0 is live/);
    assert.equal(s.overview().live, "1.1.0");
  });

  it("keeps a paused run across a restart (a new service on the same storage)", async () => {
    const sql = sqlite();
    await service(sql).startRun({ mode: "hitl", agents: false });
    const restarted = service(sql);
    assert.equal(restarted.run()?.status, "awaiting_approval");
    const done = await restarted.approve({ approved: false });
    assert.equal(done.status, "done");
    assert.equal(restarted.overview().releases.find((r) => r.version === "1.1.0-trial.1")?.status, "rejected");
  });

  for (const scenario of ["dominant-misconception", "missing-prereq"]) {
    it(`diagnoses the live release: once ${scenario}'s fix is kept, the next run finds nothing to repair`, async () => {
      const s = service();
      s.reset(scenario);
      const first = await s.startRun({ mode: "autopilot", agents: false });
      assert.match(first.steps.at(-1)!.title, /^Kept/);

      const second = await s.startRun({ mode: "autopilot", agents: false });
      assert.equal(second.status, "done");
      assert.deepEqual(
        second.steps.map((step) => step.node),
        ["curator", "reflection", "plan_release"],
        "no authoring or release attempt for a fault that's already fixed",
      );
      assert.match(second.steps[0]!.title, /flag_for_review/);
      assert.equal(s.overview().releases.filter((r) => r.status === "trial" || r.status === "rejected").length, 0);
    });
  }

  it("refuses a second answer to the same approval, and a second run, before any work starts", async () => {
    const s = service();
    await s.startRun({ mode: "hitl", agents: false });
    assert.throws(() => s.beginRun({ mode: "hitl", agents: false }), /waiting for approval/);
    const claimed = s.beginApproval();
    assert.throws(() => s.beginApproval(), /Nothing is waiting for approval/);
    assert.throws(() => s.beginRun({ mode: "hitl", agents: false }), /already in progress/);
    assert.throws(() => s.reset("control"), /run is in progress/);
    const done = await s.continueApproval(claimed, { approved: true });
    assert.equal(done.status, "done");
  });

  it("refuses a run with agents when no model is configured", async () => {
    await assert.rejects(service().startRun({ mode: "hitl", agents: true }), /No model is configured/);
  });

  it("reroutes a learner to the intervention once it is live, and tracks their progress", async () => {
    const s = service();
    const { answers, certainty } = believerAnswers();

    const before = s.submitQuiz("ada", "agent-loop", answers, certainty);
    assert.equal(before.release, "1.0.0");
    assert.equal(before.passed, false);
    assert.deepEqual(before.steps.map((step) => step.kind), ["retake"]);

    await s.startRun({ mode: "autopilot", agents: false });
    const after = s.submitQuiz("ada", "agent-loop", answers, certainty);
    assert.equal(after.release, "1.1.0");
    assert.deepEqual(after.steps.map((step) => step.kind), ["intervention", "retake"]);
    assert.equal(after.interventions[0]?.intervention.targets, "model-executes-actions");

    const right = lesson.quiz.map((item) => correctResponse(item));
    for (let i = 0; i < 2; i++) s.submitQuiz("ada", "agent-loop", right, right.map(() => 3 as const));
    const [progress] = s.progress("ada");
    assert.equal(progress?.attempts, 4);
    assert.equal(progress?.passed, true);
    assert.equal(progress?.mastered, true);
    assert.deepEqual(s.events.forLearner("ada").filter((e) => e.kind === "answer").map((e) => e.release), ["1.0.0", "1.1.0", "1.1.0", "1.1.0"]);
  });

  it("tracks sessions and activity, and summarises them on My progress", async () => {
    const s = service();
    s.startSession("ada", "c1");
    s.track("ada", "c1", { kind: "lesson", lesson: "agent-loop", active_ms: 90_000 });
    s.submitQuiz("ada", "agent-loop", believerAnswers().answers, believerAnswers().certainty, "c1");
    s.endSession("ada", "c1");

    const me = s.myProgress("ada");
    assert.equal(me.totals.sessions, 1);
    assert.equal(me.totals.quizzes, 1);
    assert.equal(me.totals.active_ms, 90_000);
    assert.equal(me.lessons.find((l) => l.lesson === "agent-loop")?.attempts, 1);
    assert.equal(me.beliefs[0]?.id, "model-executes-actions");
    assert.equal(me.beliefs[0]?.cleared, false);
  });

  it("validates activity events against the live release, and rate-limits them", async () => {
    const s = service();
    assert.throws(() => s.track("ada", "c1", { kind: "lesson", lesson: "nope", active_ms: 1 }), /No lesson "nope"/);
    assert.throws(() => s.track("ada", "c1", { kind: "lesson", lesson: "agent-loop", active_ms: 99 * 60_000 }), /Invalid activity event/);
    assert.throws(() => s.track("ada", "c1", { kind: "intervention", event: "shown", block_id: "x", context: "path" }), /No intervention "x"/);
    for (let i = 0; i < 60; i++) s.track("ada", "c2", { kind: "lesson", lesson: "agent-loop", active_ms: 1 });
    assert.throws(() => s.track("ada", "c2", { kind: "lesson", lesson: "agent-loop", active_ms: 1 }), /Too many activity events/);
  });

  it("records an intervention shown and completed once it's live", async () => {
    const s = service();
    await s.startRun({ mode: "autopilot", agents: false });
    const block = "agent-loop/the-harness-does-the-acting/i1";
    s.track("ada", "c1", { kind: "intervention", event: "shown", block_id: block, context: "path" });
    s.track("ada", "c1", { kind: "intervention", event: "completed", block_id: block, context: "path" });
    assert.deepEqual(s.myProgress("ada").interventions.map((i) => [i.block_id, i.completed]), [[block, true]]);
  });

  it("deletes only the caller's data", () => {
    const s = service();
    s.submitQuiz("ada", "agent-loop", believerAnswers().answers, believerAnswers().certainty);
    s.submitQuiz("bob", "agent-loop", believerAnswers().answers, believerAnswers().certainty);
    assert.equal(s.deleteMyData("ada").deleted, 2, "the answer and the path step");
    assert.equal(s.myProgress("ada").totals.quizzes, 0);
    assert.equal(s.myProgress("bob").totals.quizzes, 1);
  });

  it("resets to another scenario", () => {
    const s = service();
    s.submitQuiz("ada", "agent-loop", believerAnswers().answers, believerAnswers().certainty);
    s.reset("missing-prereq");
    assert.equal(s.overview().scenario, "missing-prereq");
    assert.deepEqual(s.snapshot().lessons.find((l) => l.id === "multi-agent")?.prerequisites, ["structured-output"]);
    assert.deepEqual(s.events.forLearner("ada"), []);
  });
});
