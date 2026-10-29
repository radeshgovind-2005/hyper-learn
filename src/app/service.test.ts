import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import type { Certainty, Response } from "../assessment/items.js";
import { getCourse } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { armOf } from "../measure/real.js";
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

  describe("a run cut off by a restart", () => {
    it("ends in an error instead of blocking new runs and reset", async () => {
      const sql = sqlite();
      service(sql).beginRun({ mode: "autopilot", agents: false });
      const restarted = service(sql);
      assert.equal(restarted.run()?.status, "error");
      assert.match(restarted.run()?.error ?? "", /restarted/);
      restarted.reset("control");
      const again = await restarted.startRun({ mode: "autopilot", agents: false });
      assert.equal(again.status, "done");
    });

    it("asks again for an approval whose answer never took effect", async () => {
      const sql = sqlite();
      const first = service(sql);
      await first.startRun({ mode: "hitl", agents: false });
      first.beginApproval();
      const restarted = service(sql);
      const run = restarted.run();
      assert.equal(run?.status, "awaiting_approval");
      assert.equal(run?.steps.filter((s) => s.status === "waiting").length, 1);
      const done = await restarted.approve({ approved: true });
      assert.equal(done.status, "done");
      assert.equal(restarted.overview().live, "1.1.0");
    });

    it("reverts a simulated trial that was never measured", () => {
      const sql = sqlite();
      const first = service(sql);
      first.beginRun({ mode: "autopilot", agents: false });
      const live = first.releases.live();
      first.releases.add({ ...structuredClone(live), version: "1.1.0-trial.1", parent: live.version, status: "trial", trial_source: "simulated" });
      const restarted = service(sql);
      assert.equal(restarted.run()?.status, "error");
      const trial = restarted.releases.get("1.1.0-trial.1");
      assert.equal(trial?.status, "reverted");
      assert.equal(trial?.decision?.verdict, "revert");
      assert.equal(restarted.overview().live, "1.0.0");
    });

    it("leaves a trial on real learners collecting answers", () => {
      const sql = sqlite();
      const first = service(sql);
      first.beginRun({ mode: "autopilot", agents: false, source: "real" });
      const live = first.releases.live();
      first.releases.add({ ...structuredClone(live), version: "1.1.0-trial.1", parent: live.version, status: "trial", trial_source: "real" });
      const restarted = service(sql);
      assert.equal(restarted.run()?.status, "trial_running");
      assert.equal(restarted.trial()?.version, "1.1.0-trial.1");
      restarted.stopTrial("ada");
      assert.equal(restarted.run()?.status, "done");
    });

    it("leaves a run in progress alone in the same instance", () => {
      const s = service();
      s.beginRun({ mode: "autopilot", agents: false });
      assert.equal(s.run()?.status, "running");
    });
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

  it("checks arguments that arrive untyped from browsers", async () => {
    const s = service();
    assert.throws(() => s.beginRun({ mode: "yolo", agents: false } as never), /Invalid run options/);
    assert.throws(() => s.beginRun({ mode: "hitl", agents: "false" } as never), /Invalid run options/);
    assert.throws(() => s.beginRun({ mode: "hitl", agents: false, source: "everyone" } as never), /Invalid run options/);
    await s.startRun({ mode: "hitl", agents: false });
    await assert.rejects(s.approve({ approved: "false" } as never), /Invalid approval/);
    assert.equal(s.run()?.status, "awaiting_approval", "a refused answer doesn't claim the approval");
    const { answers, certainty } = believerAnswers();
    assert.throws(() => s.submitQuiz("ada", "agent-loop", answers, certainty.map(() => 5) as never), /Certainty is 1, 2 or 3/);
    assert.throws(() => s.submitQuiz("ada", "agent-loop", answers, certainty, undefined, "q1" as never), /item_ids must be a list/);
    assert.throws(() => s.submitQuiz("ada", "agent-loop", "all right" as never, certainty), /as lists/);
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

  it("lists learners for instructors: who needs help, and the beliefs most learners still hold", () => {
    const s = service();
    s.recordProfile({ userId: "ada", role: "learner", name: "Ada" });
    s.recordProfile({ userId: "bob", role: "learner", email: "bob@example.com" });
    s.submitQuiz("ada", "agent-loop", believerAnswers().answers, believerAnswers().certainty);
    const right = lesson.quiz.map((item) => correctResponse(item));
    s.submitQuiz("bob", "agent-loop", right, right.map(() => 3 as const));

    const { summary, learners } = s.learners();
    assert.equal(summary.learners, 2);
    assert.equal(summary.needs_help, 1);
    assert.equal(summary.common_beliefs[0]?.id, "model-executes-actions");
    const ada = learners.find((l) => l.user_id === "ada")!;
    assert.equal(ada.name, "Ada");
    assert.equal(ada.needs_help, true);
    assert.ok(ada.open_beliefs.some((b) => b.id === "model-executes-actions"));
    assert.equal(learners.find((l) => l.user_id === "bob")?.needs_help, false);
  });

  it("shows one learner's history as a readable timeline, and forgets their profile on delete", () => {
    const s = service();
    s.recordProfile({ userId: "ada", role: "learner", name: "Ada" });
    s.startSession("ada", "c1");
    s.track("ada", "c1", { kind: "lesson", lesson: "agent-loop", active_ms: 120_000 });
    s.submitQuiz("ada", "agent-loop", believerAnswers().answers, believerAnswers().certainty, "c1");
    const detail = s.learnerDetail("ada");
    assert.equal(detail.profile.name, "Ada");
    assert.match(detail.timeline[0]!.text, /^Quiz on The Agent Loop: \d+%, not passed, showing “The model carries out/);
    assert.equal(detail.timeline[0]!.outcome, "fail");
    assert.deepEqual(detail.timeline.slice(1).map((t) => t.text), ["2 min reading The Agent Loop", "Opened HyperLearn"]);

    s.deleteMyData("ada");
    s.endSession("ada", "c1"); // the tab closes after deleting: nothing comes back
    assert.equal(s.learnerDetail("ada").profile.name, null);
    assert.equal(s.learners().summary.learners, 0);
  });

  describe("real learners", () => {
    /** A service whose clock moves a second per reading, so "since the trial started" means something. */
    const ticking = (sql = sqlite()) => {
      let t = Date.parse("2026-10-29T12:00:00.000Z");
      return new CourseService(sql, { now: () => new Date((t += 1000)).toISOString(), newId: () => `run-${++ids}` });
    };
    const right = lesson.quiz.map((item) => correctResponse(item));
    const sure = right.map(() => 3 as const);
    /** Learners whose first attempt shows the belief, for a run to diagnose. */
    const struggling = (s: CourseService, n: number, prefix = "early") => {
      const { answers, certainty } = believerAnswers();
      for (let i = 0; i < n; i++) s.submitQuiz(`${prefix}-${i}`, "agent-loop", answers, certainty);
    };
    /** Starts a real run on 40 struggling learners and approves its trial. */
    const startTrial = async (s: CourseService) => {
      struggling(s, 40);
      const paused = await s.startRun({ mode: "hitl", agents: false, source: "real" });
      assert.equal(paused.status, "awaiting_approval");
      assert.equal(paused.approval?.version, "1.1.0-trial.1");
      return s.approve({ approved: true });
    };
    const inArm = (arm: "control" | "treatment", n: number) =>
      Array.from({ length: 1000 }, (_, i) => `user-${i}`)
        .filter((id) => armOf(id, "1.1.0-trial.1") === arm)
        .slice(0, n);

    it("with no answers yet, a real run finds nothing to repair", async () => {
      const s = service();
      const done = await s.startRun({ mode: "autopilot", agents: false, source: "real" });
      assert.equal(done.status, "done");
      assert.equal(s.overview().releases.length, 1);
    });

    it("diagnoses real answers, and an approved change becomes a trial that waits for learners", async () => {
      const s = ticking();
      const run = await startTrial(s);
      assert.equal(run.status, "trial_running");
      assert.match(run.steps.at(-1)!.title, /Trial running on real learners: 0\/30 and 0\/30/);

      const trial = s.overview().trial;
      assert.equal(trial?.version, "1.1.0-trial.1");
      assert.equal(s.overview().live, "1.0.0", "nothing is released until the trial is decided");
      assert.throws(() => s.beginRun({ mode: "hitl", agents: false }), /trial is running/);
      assert.deepEqual(s.evaluateTrial(), { status: "pending", pending: { pending: true, lesson: "agent-loop", control: 0, treatment: 0, needed: 30 } });
    });

    it("serves each half of learners their own release, and grades them on it", async () => {
      const s = ticking();
      await startTrial(s);
      const [control] = inArm("control", 1);
      const [treated] = inArm("treatment", 1);
      assert.deepEqual(s.myRelease(control!), { version: "1.0.0", arm: "control" });
      assert.deepEqual(s.myRelease(treated!), { version: "1.1.0-trial.1", arm: "treatment" });

      const { answers, certainty } = believerAnswers();
      assert.equal(s.submitQuiz(control!, "agent-loop", answers, certainty).release, "1.0.0");
      const result = s.submitQuiz(treated!, "agent-loop", answers, certainty);
      assert.equal(result.release, "1.1.0-trial.1");
      assert.deepEqual(result.steps.map((step) => step.kind), ["intervention", "retake"], "only the treated learner is routed to the new help");
    });

    it("keeps the change once both halves have enough learners and it clearly helped", async () => {
      const s = ticking();
      await startTrial(s);
      const { answers, certainty } = believerAnswers();
      for (const id of inArm("control", 35)) {
        s.submitQuiz(id, "agent-loop", answers, certainty);
        s.submitQuiz(id, "agent-loop", answers, certainty); // still holds the belief on the retake
      }
      for (const id of inArm("treatment", 35)) {
        s.submitQuiz(id, "agent-loop", answers, certainty);
        s.submitQuiz(id, "agent-loop", right, sure); // the intervention cleared it
      }
      const updates: string[] = [];
      assert.deepEqual(s.evaluateTrial((run) => updates.push(run.status)), { status: "decided", verdict: "keep", live: "1.1.0" });
      assert.equal(s.overview().trial, null);
      assert.equal(s.run()?.status, "done");
      assert.match(s.run()!.steps.at(-1)!.title, /Kept: 1.1.0 is live/);
      assert.deepEqual(updates, ["done"]);
      assert.deepEqual(s.myRelease(inArm("control", 1)[0]!), { version: "1.1.0" }, "everyone gets the kept change");
      assert.equal(s.overview().releases.find((r) => r.version === "1.1.0-trial.1")?.measurement?.source, "learners");
    });

    it("stops a trial by hand: reverted, everyone back on the live release", async () => {
      const s = ticking();
      await startTrial(s);
      s.stopTrial("user_admin");
      assert.equal(s.overview().trial, null);
      assert.equal(s.overview().releases.find((r) => r.version === "1.1.0-trial.1")?.status, "reverted");
      assert.equal(s.run()?.status, "done");
      assert.match(s.run()!.steps.at(-1)!.detail!, /Stopped by user_admin/);
      assert.deepEqual(s.myRelease(inArm("treatment", 1)[0]!), { version: "1.0.0" });
      assert.throws(() => s.stopTrial("user_admin"), /No trial is running/);
    });

    it("leaves simulated runs measuring at once", async () => {
      const s = service();
      const done = await s.startRun({ mode: "autopilot", agents: false, source: "simulated" });
      assert.equal(done.status, "done");
      assert.equal(s.overview().trial, null);
    });
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
