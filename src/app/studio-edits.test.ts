import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runEdit } from "../edit/run.js";
import type { EditPlanDraft } from "../edit/schemas.js";
import { buildCourse, cannedBuilderModels } from "../generate/index.js";
import { responder } from "../generate/canned.js";
import { EXAM, NOTES } from "../generate/fixtures.test-helpers.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import type { CourseBuilder, CourseEditor } from "./courses.js";
import { CourseService } from "./service.js";

// Owner edits through the service: a request is prepared in the background, reviewed, then applied to
// the draft or released as a new version, with the same canned models as the build (no network).

const canned: CourseBuilder = (input, _structured, onStep) => buildCourse(input, cannedBuilderModels(), { onStep });
const EMPTY: EditPlanDraft = { reply: "", rewrite_sections: [], new_sections: [], new_lessons: [], new_objectives: [], more_questions: [] };

function studio(plan: EditPlanDraft = EMPTY) {
  const editor: CourseEditor = (request, context, _structured, onStep) =>
    runEdit(request, context, { ...cannedBuilderModels(), editor: responder(() => plan) }, { onStep });
  const s = new CourseService(sqlite(), {
    course: "studio",
    builder: canned,
    editor,
    ownerModels: {
      secret: "test-only-secret-0123456789abcdefghijkl",
      config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
      choices: ["muse-spark-1.3"],
    },
  });
  s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: { userId: "user_ada", role: "learner", name: "Ada" } });
  for (const source of [NOTES, EXAM]) s.addSource({ name: source.name, pages: source.pages });
  return s;
}

async function built(plan?: EditPlanDraft) {
  const s = studio(plan);
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  const build = await s.continueBuild(s.beginBuild());
  assert.equal(build.status, "done", build.problems?.join("\n") ?? "");
  return s;
}

async function edit(s: CourseService, request: unknown) {
  const done = await s.continueEdit(s.beginEdit(request, "user_ada"));
  assert.equal(done.status, "ready", done.problems?.join("\n") ?? "");
  return done;
}

describe("owner edits in the studio", () => {
  it("can't start before there is a course to edit, or with a bad request", async () => {
    const s = studio();
    await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
    assert.throws(() => s.beginEdit({ kind: "ask", instruction: "More examples" }, "user_ada"), /Build the course first/);
    const b = await built();
    assert.throws(() => b.beginEdit({ kind: "ask", instruction: "" }, "user_ada"), /Say what/);
    assert.throws(() => b.beginEdit({ kind: "tune", section_id: "x", preset: "louder" }, "user_ada"));
    assert.throws(() => b.beginEdit({ kind: "add_source", source_id: "s9" }, "user_ada"), /No file/);
  });

  it("tunes a section of the draft, then applies it in place", async () => {
    const s = await built();
    const section = s.draft().lessons[0]!.sections[0]!;
    const e = await edit(s, { kind: "tune", section_id: section.id, preset: "worked_example" });
    assert.equal(s.overview().edit?.status, "ready");
    assert.equal(e.proposal!.summary[0]!.kind, "rewrite");
    assert.ok(e.steps.some((step) => step.stage === "done"));

    assert.deepEqual(s.applyEdit(e.id, "user_ada"), { applied_as: "draft" });
    const after = s.draft().lessons[0]!.sections[0]!;
    assert.ok(after.blocks.some((b) => b.archived), "the old text is kept, archived");
    assert.throws(() => s.applyEdit(e.id, "user_ada"), /no proposal/, "applied once");
  });

  it("refuses a draft proposal after the draft changed under it", async () => {
    const s = await built();
    const [a, b] = s.draft().lessons[0]!.sections;
    const first = await edit(s, { kind: "tune", section_id: a!.id, preset: "plainer" });
    s.applyEdit(first.id, "user_ada");
    const second = s.beginEdit({ kind: "tune", section_id: b!.id, preset: "plainer" }, "user_ada");
    // Someone else's edit lands in between.
    (s as unknown as { setDraft(x: unknown): void }).setDraft(s.draft());
    await s.continueEdit(second);
    assert.throws(() => s.applyEdit(second.id, "user_ada"), /changed since/);
  });

  it("releases an edit of a published course as a new version that can be reverted", async () => {
    const s = await built();
    s.publish();
    const section = s.snapshot().lessons[1]!.sections[0]!;
    const e = await edit(s, { kind: "tune", section_id: section.id, instruction: "Shorter sentences." });
    assert.deepEqual(s.applyEdit(e.id, "user_ada"), { applied_as: "1.1.0" });
    const releases = s.overview().releases;
    const live = releases.find((r) => r.status === "live")!;
    assert.equal(live.version, "1.1.0");
    assert.equal(live.parent, "1.0.0");
    assert.match(live.rationale ?? "", /Owner tuned .*Shorter sentences/);
    assert.equal(releases.find((r) => r.version === "1.0.0")!.status, "superseded");
    assert.ok(s.snapshot().lessons[1]!.sections[0]!.blocks.some((b) => b.archived));
    // Learners are served the new release.
    assert.equal(s.myRelease("user_bob").version, "1.1.0");
  });

  it("adds a file to a published course and releases what it adds", async () => {
    const plan: EditPlanDraft = {
      ...EMPTY,
      reply: "A new section from the frost notes.",
      new_sections: [{ lesson: "", after: null, title: "Frost cloths", pages: [{ source: "s3", page: 1 }], objectives: [], instruction: "From the new notes." }],
    };
    const s = await built(plan);
    s.publish();
    plan.new_sections[0]!.lesson = s.snapshot().lessons[0]!.id;
    assert.throws(() => s.removeSource("s1"), /keeps its sources/);
    const added = s.addSource({ name: "frost-notes.md", role: "material", pages: ["Frost cloths protect the tip on cold nights, so the clock keeps time."] });
    assert.equal(added.id, "s3");
    const e = await edit(s, { kind: "add_source", source_id: "s3", instruction: "winter" });
    const result = s.applyEdit(e.id, "user_ada");
    assert.equal(result.applied_as, "1.1.0");
    assert.equal(s.snapshot().lessons[0]!.sections[0]!.title, "Frost cloths");
    assert.match(s.overview().releases.find((r) => r.version === "1.1.0")!.rationale ?? "", /Owner added frost-notes\.md: winter/);
  });

  it("keeps a failed request's reason, and can discard a proposal", async () => {
    const s = await built({ ...EMPTY, reply: "The pages don't cover that." });
    const failed = await s.continueEdit(s.beginEdit({ kind: "ask", instruction: "Add quantum clocks" }, "user_ada"));
    assert.equal(failed.status, "failed");
    assert.match(failed.problems!.join(), /don't cover/);

    const section = s.draft().lessons[0]!.sections[0]!;
    await edit(s, { kind: "tune", section_id: section.id, preset: "key_idea" });
    s.discardEdit();
    assert.equal(s.overview().edit?.status, "discarded");
  });
});
