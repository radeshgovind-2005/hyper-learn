import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import type { Response } from "../assessment/items.js";
import type { CoachRepairer, CourseBuilder } from "../app/courses.js";
import { CourseService } from "../app/service.js";
import type { CourseSnapshot } from "../course/compile.js";
import { buildCourse, cannedBuilderModels } from "../generate/index.js";
import { EXAM, INPUT, NOTES } from "../generate/fixtures.test-helpers.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import { type DiagnosticQuestion, drawDiagnostic, scoreDiagnostic, targetKey } from "./diagnose.js";
import { approachFor, writeRepair } from "./repair.js";

// The study coach on a course built by the real generator (canned models, no network).

async function course(): Promise<CourseSnapshot> {
  const result = await buildCourse(INPUT, cannedBuilderModels());
  assert.ok(result.ok);
  return result.snapshot;
}

const right = (qs: readonly DiagnosticQuestion[]) => qs.map((q) => correctResponse(q.item));
/** A wrong answer that reveals what `want` asks for (a gap or a misconception), else any wrong one. */
function wrongly(q: DiagnosticQuestion, want: (r: { points_to: string; misconception?: string }) => boolean): Response {
  const options = wrongOptions(q.item, q.lesson);
  return (options.find((o) => want(o.reveals)) ?? options[0]!).response;
}

describe("study coach: diagnosis", () => {
  it("asks about the lesson and the lessons it builds on, one question per objective", async () => {
    const snapshot = await course();
    const [first, second] = snapshot.lessons;
    const qs = drawDiagnostic(snapshot, second!.id, { seed: 1 });
    const own = (snapshot.objectives ?? []).filter((o) => o.lesson === second!.id);
    assert.equal(qs.filter((q) => q.lesson === second!.id).length, own.length);
    assert.ok(qs.some((q) => q.lesson === first!.id), "includes a question from the prerequisite");
    assert.deepEqual(drawDiagnostic(snapshot, second!.id, { seed: 1 }), qs, "same seed, same questions");
    const seen = qs.map((q) => q.item.id);
    assert.ok(drawDiagnostic(snapshot, second!.id, { seed: 2, seen }).some((q) => !seen.includes(q.item.id)), "prefers unseen questions");
  });

  it("all right: ready for the exam", async () => {
    const snapshot = await course();
    const lesson = snapshot.lessons[1]!.id;
    const qs = drawDiagnostic(snapshot, lesson, { seed: 3 });
    const result = scoreDiagnostic(snapshot, lesson, qs, right(qs));
    assert.equal(result.priority.kind, "ready");
    assert.ok(result.map.every((m) => m.state === "strong"));
  });

  it("puts a gap in an earlier lesson first: the rest builds on it", async () => {
    const snapshot = await course();
    const [first, second] = snapshot.lessons;
    const qs = drawDiagnostic(snapshot, second!.id, { seed: 4 });
    const answers = qs.map((q) =>
      q.lesson === first!.id ? wrongly(q, () => true) : wrongly(q, (r) => Boolean(r.misconception)),
    );
    const result = scoreDiagnostic(snapshot, second!.id, qs, answers);
    assert.equal(result.priority.kind, "gap");
    assert.equal(result.priority.lesson, first!.id);
    assert.ok(result.next.some((t) => t.kind === "misconception"), "the mix-up comes next");
    assert.ok(result.wrong.length > 0 && result.wrong.every((w) => w.prompt));
  });

  it("a misconception shown in the lesson comes before a weak objective", async () => {
    const snapshot = await course();
    const first = snapshot.lessons[0]!; // no prerequisites
    const qs = drawDiagnostic(snapshot, first.id, { seed: 5 });
    const answers = qs.map((q) => wrongly(q, (r) => Boolean(r.misconception)));
    const result = scoreDiagnostic(snapshot, first.id, qs, answers);
    assert.equal(result.priority.kind, "misconception");
    assert.match(result.priority.why, /mix-up/);
    assert.throws(() => scoreDiagnostic(snapshot, first.id, qs, answers.slice(1)), /Answer all/);
  });
});

describe("study coach: repair", () => {
  it("writes a personal lesson from the target's pages, as a refutation for a misconception", async () => {
    const snapshot = await course();
    const lesson = snapshot.lessons[0]!;
    const misconception = snapshot.misconceptions.find((m) => m.lesson === lesson.id)!;
    const prompts: string[] = [];
    const canned = cannedBuilderModels();
    const writer = { invoke: async (m: never) => (prompts.push(JSON.stringify(m)), canned.writer.invoke(m)) };
    const target = { kind: "misconception" as const, id: misconception.id, lesson: lesson.id, why: "x" };
    assert.equal(approachFor(target, 0), "refute");
    assert.equal(approachFor(target, 1), "worked_example", "a second try changes approach");
    const result = await writeRepair(
      { course: { course_id: snapshot.course_id, title: snapshot.title }, snapshot, sources: [{ ...NOTES, role: "material" }, { ...EXAM, role: "assessment" }], target, approach: "refute", note: "I don't get why it runs late", wrong: [{ item: "q", lesson: lesson.id, prompt: "Why late?", chose: "Cold" }] },
      { writer: writer as never, fact_checker: canned.fact_checker },
    );
    assert.ok(result.ok, result.ok ? "" : result.problems.join());
    assert.ok(result.repair.section.blocks.length > 0 && result.repair.section.blocks.every((b) => b.cites.length > 0), "grounded, every block cites a page");
    assert.match(prompts[0]!, /refutation text/);
    assert.match(prompts[0]!, /I don't get why it runs late/);
    assert.match(prompts[0]!, /They chose: Cold/);
  });
});

describe("study coach: through the service", () => {
  const canned: CourseBuilder = (input, _s, onStep) => buildCourse(input, cannedBuilderModels(), { onStep });
  const repairer: CoachRepairer = (input) => writeRepair(input, cannedBuilderModels());

  async function published(withRepairer = true) {
    const s = new CourseService(sqlite(), {
      course: "studio",
      builder: canned,
      ...(withRepairer && { repairer }),
      ownerModels: {
        secret: "test-only-secret-0123456789abcdefghijkl",
        config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
        choices: ["muse-spark-1.3"],
      },
    });
    s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner" } });
    for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
    await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
    const build = await s.continueBuild(s.beginBuild());
    assert.equal(build.status, "done");
    s.publish();
    return s;
  }

  it("diagnoses, writes a lesson for the learner, re-checks with new questions, and tells the owner", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[1]!;
    let state = s.startDiagnosis("user_bob", lesson.id, "the notches confuse me");
    const qs = state.diagnosis!.questions;
    state = s.submitDiagnosis("user_bob", state.diagnosis!.id, qs.map((q) => wrongly(q, () => true)));
    const priority = state.diagnosis!.result!.priority;
    assert.notEqual(priority.kind, "ready");

    const begun = s.beginRepair("user_bob");
    assert.equal(begun.write, true);
    assert.equal(begun.state.repair!.status, "running");
    await s.continueRepair("user_bob");
    state = s.coachState("user_bob");
    assert.equal(state.repair!.status, "ready", state.repair!.problems?.join() ?? "");
    assert.ok(state.repair!.lesson!.section.blocks.length > 0);
    const recheck = state.repair!.recheck!;
    assert.ok(recheck.length > 0);
    assert.ok(recheck.every((q) => !qs.some((d) => d.item.id === q.item.id)), "the re-check uses questions the diagnosis didn't");

    const result = s.submitRecheck("user_bob", state.repair!.id, recheck.map((q) => correctResponse(q.item)));
    assert.equal(result.fixed, true);
    assert.ok(result.state.fixed.includes(targetKey(priority)));

    // The exam prefers questions the coach hasn't shown.
    const shown = new Set([...qs, ...recheck].map((q) => q.item.id));
    const exam = s.exam("user_bob", lesson.id);
    assert.ok(exam.items.some((i) => !shown.has(i.id)));

    const insights = s.coachInsights();
    const row = insights.find((r) => r.key === targetKey(priority))!;
    assert.equal(row.learners, 1);
    assert.equal(row.fixed, 1);
    assert.ok(s.learnerDetail("user_bob").timeline.some((t) => /Study coach/.test(t.text)));
  });

  it("tries another approach when the re-check fails, and uses the course's own help without a model", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    let state = s.startDiagnosis("user_cy", lesson.id);
    state = s.submitDiagnosis("user_cy", state.diagnosis!.id, state.diagnosis!.questions.map((q) => wrongly(q, (r) => Boolean(r.misconception))));
    s.beginRepair("user_cy");
    await s.continueRepair("user_cy");
    const first = s.coachState("user_cy").repair!;
    const failed = s.submitRecheck("user_cy", first.id, first.recheck!.map((q) => wrongly(q, () => true)));
    assert.equal(failed.fixed, false);
    const again = s.beginRepair("user_cy", undefined, true).state.repair!;
    assert.equal(again.attempt, 1);
    assert.notEqual(again.approach, first.approach);

    const plain = await published(false);
    const l = plain.snapshot().lessons[0]!;
    let p = plain.startDiagnosis("user_dee", l.id);
    p = plain.submitDiagnosis("user_dee", p.diagnosis!.id, p.diagnosis!.questions.map((q) => wrongly(q, () => true)));
    const { write, state: after } = plain.beginRepair("user_dee");
    assert.equal(write, false);
    assert.equal(after.repair!.status, "ready");
    assert.ok(after.repair!.fallback);
    assert.equal(after.writes, false);
  });

  it("keeps each learner's coach to themselves, and refuses out-of-order calls", async () => {
    const s = await published();
    const lesson = s.snapshot().lessons[0]!;
    assert.throws(() => s.beginRepair("user_bob"), /diagnosis first/);
    const state = s.startDiagnosis("user_bob", lesson.id);
    assert.equal(s.coachState("user_eve").diagnosis, undefined);
    assert.throws(() => s.submitDiagnosis("user_eve", state.diagnosis!.id, []), /over/);
    assert.throws(() => s.startDiagnosis("user_bob", 42), /Pick a lesson/);
    s.deleteMyData("user_bob");
    assert.equal(s.coachState("user_bob").diagnosis, undefined);
  });
});
