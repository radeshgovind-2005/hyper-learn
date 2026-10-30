import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse } from "../assessment/answers.js";
import { baseSnapshot } from "../course/bundle.js";
import { courseFromSnapshot } from "../course/compile.js";
import { MAX_PAGE_CHARS } from "../course/sources.js";
import type { BuildInput } from "../generate/types.js";
import type { CourseBuilder } from "./courses.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import type { CourseRole } from "./access.js";
import { CourseService, type DirectoryLink, type OwnerModelSettings, type ServiceOptions, SOURCE_LIMITS } from "./service.js";

const NOW = "2026-10-29T12:00:00.000Z";
const ID = "c-abcdefghijkl";
const ada = { userId: "user_ada", role: "learner" as const, name: "Ada" };

/** A directory that records what course objects tell it. */
function fakeDirectory() {
  const calls: unknown[][] = [];
  const link: DirectoryLink = {
    courseUpdated: async (id, patch) => void calls.push(["course", id, patch]),
    membershipChanged: async (id, userId, role: CourseRole | null) => void calls.push(["member", id, userId, role]),
  };
  return { calls, link };
}

export const ownerModels = (secret: string | undefined = "test-only-secret-0123456789abcdefghijkl"): OwnerModelSettings => ({
  secret,
  config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
  choices: ["muse-spark-1.3", "muse-glimmer"],
});

export function studioService(options: Partial<ServiceOptions> = {}, sql = sqlite()) {
  const directory = fakeDirectory();
  const s = new CourseService(sql, { course: "studio", directory: directory.link, now: () => NOW, newId: () => "run-1", ...options });
  return { s, directory, sql };
}

export function initialisedStudio(options: Partial<ServiceOptions> = {}) {
  const made = studioService(options);
  made.s.initialise({ id: ID, title: "Parallel computing", description: "", owner: ada });
  return made;
}

describe("studio course objects", () => {
  it("hold nothing until the directory initialises them, and then only once", () => {
    const { s } = studioService();
    assert.equal(s.initialised(), false);
    assert.throws(() => s.initialise({ id: "agentic-coding", title: "x", description: "", owner: ada }), /studio course id/);
    assert.throws(() => s.initialise({ id: ID, title: " ", description: "", owner: ada }), /title/);
    s.initialise({ id: ID, title: "Parallel computing", description: "MPI", owner: ada });
    assert.equal(s.initialised(), true);
    assert.throws(() => s.initialise({ id: ID, title: "Again", description: "", owner: ada }), /already exists/);
    assert.deepEqual(s.overview().course, { id: ID, title: "Parallel computing", description: "MPI", status: "draft", featured: false });
    assert.equal(s.overview().live, null);
  });

  it("survives a restart", () => {
    const { s, sql } = studioService();
    s.initialise({ id: ID, title: "Parallel computing", description: "", owner: ada });
    assert.equal(studioService({}, sql).s.record()?.owner, "user_ada");
  });

  it("refuses learner calls until it's published", () => {
    const { s } = initialisedStudio();
    assert.throws(() => s.snapshot(), /isn't published/);
    assert.throws(() => s.myRelease("user_bob"), /isn't published/);
    assert.throws(() => s.submitQuiz("user_bob", "l1", [], []), /isn't published/);
    assert.throws(() => s.progress("user_bob"), /isn't published/);
    assert.throws(() => s.myProgress("user_bob"), /isn't published/);
    assert.throws(() => s.beginRun({ mode: "hitl", agents: false, source: "real" }), /isn't published/);
    s.startSession("user_bob", "c1");
    assert.deepEqual(s.events.forLearner("user_bob"), [], "no visits recorded on a draft");
  });

  it("lets the owner change its details and tells the directory", async () => {
    const { s, directory } = initialisedStudio();
    await s.updateDetails({ title: "Parallel programming", goal: "Write correct MPI programs" });
    assert.equal(s.record()?.goal, "Write correct MPI programs");
    assert.deepEqual(s.details(), { title: "Parallel programming", description: "", goal: "Write correct MPI programs", language: "", audience: "beginner", status: "draft" });
    assert.deepEqual(directory.calls, [["course", ID, { title: "Parallel programming", description: "" }]]);
    await assert.rejects(s.updateDetails({ owner: "user_eve" }));
    await assert.rejects(s.updateDetails({ title: "" }), /title/);
  });

  it("keeps who the course is for: set when created, changed by the owner, beginner on old records", async () => {
    const { s, sql } = studioService();
    s.initialise({ id: ID, title: "Parallel computing", description: "", audience: "advanced", owner: ada });
    assert.equal(s.details().audience, "advanced");
    await s.updateDetails({ audience: "intermediate" });
    assert.equal(s.details().audience, "intermediate");
    await assert.rejects(s.updateDetails({ audience: "expert" }), /beginner, intermediate or advanced/);
    assert.throws(() => studioService().s.initialise({ id: ID, title: "x", description: "", audience: "expert" as never, owner: ada }), /beginner, intermediate or advanced/);

    // A record stored before audiences existed.
    const { audience: _audience, ...old } = s.record()!;
    sql`UPDATE hl_meta SET value = ${JSON.stringify(old)} WHERE key = 'course'`;
    assert.equal(studioService({}, sql).s.details().audience, "beginner");
  });
});

describe("studio members and invites", () => {
  const bob = { userId: "user_bob", role: "learner" as const, email: "bob@example.com" };

  it("starts with the owner as the only member", () => {
    const { s } = initialisedStudio();
    assert.equal(s.memberRole("user_ada"), "owner");
    assert.equal(s.memberRole("user_bob"), null);
    assert.deepEqual(s.memberList().map((m) => [m.user_id, m.role, m.name]), [["user_ada", "owner", "Ada"]]);
  });

  it("lets people join with the current invite only, as learners", () => {
    const { s } = initialisedStudio();
    assert.equal(s.invite().token, null);
    assert.throws(() => s.join(bob, "anything"), /no longer valid/);
    const { token } = s.rotateInvite();
    assert.ok(token && token.length >= 32);
    assert.throws(() => s.join(bob, `${token}x`), /no longer valid/);
    assert.throws(() => s.join(bob, 42), /no longer valid/);
    assert.deepEqual(s.join(bob, token), { role: "learner" });
    assert.equal(s.memberRole("user_bob"), "learner");

    const rotated = s.rotateInvite().token!;
    assert.notEqual(rotated, token);
    assert.throws(() => s.join({ userId: "user_cy", role: "learner" }, token), /no longer valid/, "the old link stops working");
    assert.deepEqual(s.join({ userId: "user_ada", role: "learner" }, rotated), { role: "owner" }, "joining never lowers a role");
    s.revokeInvite();
    assert.throws(() => s.join({ userId: "user_cy", role: "learner" }, rotated), /no longer valid/);
  });

  it("lets the owner change and remove members, but never the owner, and tells the directory", async () => {
    const { s, directory } = initialisedStudio();
    s.join(bob, s.rotateInvite().token);
    await s.setMemberRole("user_bob", "editor");
    assert.equal(s.memberRole("user_bob"), "editor");
    await assert.rejects(s.setMemberRole("user_bob", "owner"), /editors or learners/);
    await assert.rejects(s.setMemberRole("user_bob", "admin"), /editors or learners/);
    await assert.rejects(s.setMemberRole("user_ada", "learner"), /owner's role/);
    await assert.rejects(s.setMemberRole("user_cy", "learner"), /Not a member/);
    await assert.rejects(s.removeMember("user_ada"), /can't be removed/);
    await assert.rejects(s.leave("user_ada"), /can't leave/);
    await s.removeMember("user_bob");
    assert.equal(s.memberRole("user_bob"), null);
    assert.deepEqual(directory.calls, [
      ["member", ID, "user_bob", "editor"],
      ["member", ID, "user_bob", null],
    ]);
  });

  it("has no members or invites on a built-in course", () => {
    const s = new CourseService(sqlite(), { now: () => NOW });
    assert.equal(s.memberRole("user_ada"), null);
    assert.throws(() => s.rotateInvite(), /Built-in courses/);
    assert.throws(() => s.join(bob, "x"), /Built-in courses/);
  });
});

describe("studio sources", () => {
  it("adds files as pages with ids that are never reused", () => {
    const { s } = initialisedStudio();
    const lecture = s.addSource({ name: "Lecture 1.pdf", pages: ["Amdahl's law.", "Speedup."] });
    assert.deepEqual(lecture, { id: "s1", name: "Lecture 1.pdf", role: null, pages: 2, chars: 21, shared: true });
    assert.equal(s.addSource({ name: "exam.pdf", role: "assessment", pages: ["Q1"] }).id, "s2");
    s.removeSource("s2");
    assert.equal(s.addSource({ name: "brief.md", pages: ["Build a parallel sort"] }).id, "s3");
    assert.deepEqual(s.sourceList().map((x) => x.id), ["s1", "s3"]);

    assert.equal(s.setSourceRole("s3", "brief").role, "brief");
    assert.equal(s.setSourceRole("s3", null).role, null);
    assert.throws(() => s.setSourceRole("s3", "notes"), /Unknown role/);
    assert.equal(s.appendPages("s1", ["Gustafson."]).pages, 3);
    assert.deepEqual(s.sourceTexts()[0]?.pages, ["Amdahl's law.", "Speedup.", "Gustafson."]);
    assert.throws(() => s.appendPages("s9", ["x"]), /No source/);
  });

  it("validates uploads and cuts over-long pages", () => {
    const { s } = initialisedStudio();
    assert.throws(() => s.addSource({ name: "", pages: ["x"] }), /Name the file/);
    assert.throws(() => s.addSource({ name: "a", pages: [] }), /at least one page/);
    assert.throws(() => s.addSource({ name: "a", pages: [42] }));
    assert.throws(() => s.addSource({ name: "a", pages: ["x"], id: "s7" }), "the id is the server's");
    assert.throws(() => s.addSource({ name: "a", pages: ["x"], role: "notes" }));
    assert.equal(s.addSource({ name: "long", pages: ["x".repeat(MAX_PAGE_CHARS + 5)] }).chars, MAX_PAGE_CHARS);
  });

  it("enforces the limits server-side", () => {
    const { s } = initialisedStudio();
    const page = "x".repeat(MAX_PAGE_CHARS);
    const perCall = Math.floor(SOURCE_LIMITS.charsPerCall / MAX_PAGE_CHARS);
    assert.throws(() => s.addSource({ name: "big", pages: Array(perCall + 1).fill(page) }), /at a time/);
    // Fill up to the course total with full calls, then one more page is too many.
    let added = 0;
    const { id } = s.addSource({ name: "big", pages: Array(perCall).fill(page) });
    added += perCall * MAX_PAGE_CHARS;
    while (added + perCall * MAX_PAGE_CHARS <= SOURCE_LIMITS.chars) {
      s.addSource({ name: `more ${added}`, pages: Array(perCall).fill(page) });
      added += perCall * MAX_PAGE_CHARS;
    }
    assert.throws(() => s.appendPages(id, ["x".repeat(SOURCE_LIMITS.chars - added + 1)]), /in all/);

    const many = initialisedStudio().s;
    for (let i = 0; i < SOURCE_LIMITS.sources; i++) many.addSource({ name: `f${i}`, pages: ["x"] });
    assert.throws(() => many.addSource({ name: "one more", pages: ["x"] }), /at most 30 sources/);
  });

  it("is only for studio courses", () => {
    const s = new CourseService(sqlite(), { now: () => NOW });
    assert.throws(() => s.addSource({ name: "a", pages: ["x"] }), /Built-in courses/);
  });
});

describe("the owner's model key", () => {
  it("is stored sealed, never returned, and makes agents available", async () => {
    const { s, sql } = initialisedStudio({ ownerModels: ownerModels() });
    assert.deepEqual(s.modelSettings(), { hasKey: false, model: null, choices: ["muse-spark-1.3", "muse-glimmer"], keysAvailable: true, set_at: null });
    assert.equal(s.agentsAvailable(), false);
    const settings = await s.setModelKey("  sk-meta-secret-123  ", "muse-glimmer");
    assert.deepEqual(settings, { hasKey: true, model: "muse-glimmer", choices: ["muse-spark-1.3", "muse-glimmer"], keysAvailable: true, set_at: NOW });
    assert.equal(s.agentsAvailable(), true);
    assert.equal(s.overview().agentsAvailable, true);

    const everything = JSON.stringify([
      sql`SELECT * FROM hl_meta`,
      s.overview(),
      s.modelSettings(),
      s.courseInfo(),
    ]);
    assert.ok(!everything.includes("sk-meta-secret-123"), "the key is nowhere in storage, state or settings");
    s.clearModelKey();
    assert.equal(s.modelSettings().hasKey, false);
  });

  it("refuses bad keys, models outside MODEL_CHOICES, and a missing Worker secret", async () => {
    const { s } = initialisedStudio({ ownerModels: ownerModels() });
    await assert.rejects(s.setModelKey("short", "muse-glimmer"), /doesn't look like an API key/);
    await assert.rejects(s.setModelKey("sk-with space", "muse-glimmer"), /no spaces/);
    await assert.rejects(s.setModelKey("sk-meta-secret-123", "gpt-anything"), /Pick one of these models/);
    await assert.rejects(s.setModelKey(42, "muse-glimmer"));

    const unset = initialisedStudio({ ownerModels: ownerModels("") }).s;
    assert.equal(unset.modelSettings().keysAvailable, false);
    await assert.rejects(unset.setModelKey("sk-meta-secret-123", "muse-glimmer"), /KEY_ENCRYPTION_SECRET/);
  });

  it("is used for agent runs only through the course's own provider", async () => {
    const { s } = initialisedStudio({ ownerModels: ownerModels() });
    await s.setModelKey("sk-meta-secret-123", "muse-glimmer");
    // Not published: runs are refused before any model is made.
    assert.throws(() => s.beginRun({ mode: "hitl", agents: true, source: "real" }), /isn't published/);
  });
});

describe("studio lifecycle", () => {
  const KEY = "sk-meta-secret-123";
  /** A builder that returns a fixed (valid) course and reports two steps. */
  function fakeBuilder(result?: "fail" | "throw" | "invalid") {
    const seen: { input?: BuildInput; structured?: unknown } = {};
    const builder: CourseBuilder = async (input, structured, onStep) => {
      seen.input = input;
      seen.structured = structured;
      onStep({ stage: "classify", title: "Classified 1 source", status: "ok", at: NOW });
      if (result === "throw") throw new Error(`401 Incorrect API key provided: ${KEY}`);
      onStep({ stage: "done", title: "Built", status: "ok", at: NOW });
      const report = { steps: [], model_calls: 3, warnings: ["thin pool in l2"] };
      if (result === "fail") return { ok: false, problems: ["objective o1 has too few items"], report };
      const snapshot = { ...baseSnapshot(), course_id: "whatever", version: "9.9.9" };
      if (result === "invalid") snapshot.lessons[1]!.prerequisites = ["no-such-lesson"];
      return { ok: true, snapshot, report };
    };
    return { builder, seen };
  }

  async function ready(result?: "fail" | "throw" | "invalid") {
    const { builder, seen } = fakeBuilder(result);
    const made = initialisedStudio({ ownerModels: ownerModels(), builder });
    made.s.addSource({ name: "lecture.md", pages: ["Amdahl's law bounds speedup."] });
    await made.s.updateDetails({ goal: "Reason about speedup" });
    await made.s.setModelKey(KEY, "muse-spark-1.3");
    return { ...made, seen };
  }

  it("refuses to build without sources, a key or a generator", async () => {
    const noBuilder = initialisedStudio({ ownerModels: ownerModels() }).s;
    noBuilder.addSource({ name: "a", pages: ["x"] });
    await noBuilder.setModelKey(KEY, "muse-spark-1.3");
    assert.throws(() => noBuilder.beginBuild(), /generation isn't available/);

    const { builder } = fakeBuilder();
    const empty = initialisedStudio({ ownerModels: ownerModels(), builder }).s;
    assert.throws(() => empty.beginBuild(), /at least one source/);
    empty.addSource({ name: "a", pages: ["x"] });
    assert.throws(() => empty.beginBuild(), /model API key/);
    assert.throws(() => empty.publish(), /Build the course/);
  });

  it("says what the server lacks when a saved key can't be used", async () => {
    const { builder } = fakeBuilder();
    const noEndpoint = initialisedStudio({ ownerModels: { ...ownerModels(), config: { ...ownerModels().config, baseURL: "" } }, builder }).s;
    noEndpoint.addSource({ name: "a", pages: ["x"] });
    await noEndpoint.setModelKey(KEY, "muse-spark-1.3");
    assert.throws(() => noEndpoint.beginBuild(), /MODEL_BASE_URL/);

    const noSecret = initialisedStudio({ ownerModels: ownerModels(""), builder }).s;
    noSecret.addSource({ name: "a", pages: ["x"] });
    assert.throws(() => noSecret.beginBuild(), /KEY_ENCRYPTION_SECRET/);
  });

  it("builds in the background with the owner's key, then publishes v1.0.0 for learners", async () => {
    const { s, seen, directory } = await ready();
    const updates: (string | undefined)[] = [];
    const build = s.beginBuild(() => updates.push(s.overview().build?.status));
    assert.equal(s.record()?.status, "building");
    assert.throws(() => s.beginBuild(), /already running/);
    assert.throws(() => s.addSource({ name: "b", pages: ["y"] }), /Wait for the build/);

    const done = await s.continueBuild(build, () => updates.push(s.overview().build?.status));
    assert.equal(done.status, "done");
    assert.deepEqual(done.steps.map((step) => step.title), ["Classified 1 source", "Built"]);
    assert.deepEqual(done.warnings, ["thin pool in l2"]);
    assert.equal(done.model_calls, 3);
    assert.ok(updates.length >= 3, "the UI hears each step");
    assert.equal(s.record()?.status, "review");
    assert.equal(seen.input?.course_id, ID);
    assert.equal(seen.input?.goal, "Reason about speedup");
    assert.equal(seen.input?.audience, "beginner", "the build is told who the course is for");
    assert.deepEqual(seen.input?.sources.map((x) => x.id), ["s1"]);
    assert.equal(typeof seen.structured, "function");

    const draft = s.draft();
    assert.equal(draft.course_id, ID, "code sets the course id");
    assert.equal(draft.version, "1.0.0", "and the version");
    assert.throws(() => s.snapshot(), /isn't published/, "a draft isn't for learners");

    assert.deepEqual(s.publish(), { live: "1.0.0" });
    assert.equal(s.record()?.status, "published");
    assert.equal(s.overview().live, "1.0.0");
    assert.throws(() => s.publish(), /Already published/);
    assert.throws(() => s.beginBuild(), /published/);
    // New files may join (an edit then adds what they cover); the cited ones can't change.
    const added = s.addSource({ name: "b", pages: ["y"] });
    assert.throws(() => s.removeSource(added.id), /keeps its sources/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      directory.calls.filter((c) => c[0] === "course" && "status" in (c[2] as object)).map((c) => (c[2] as { status: string }).status),
      ["building", "review", "published"],
    );

    // Learners can take it now, on v1.0.0.
    const lesson = courseFromSnapshot(s.snapshot()).lessons[0]!;
    const answers = lesson.quiz.map((item) => correctResponse(item));
    const result = s.submitQuiz("user_bob", lesson.id, answers, answers.map(() => 3 as const));
    assert.equal(result.release, "1.0.0");
    assert.equal(s.progress("user_bob")[0]?.lesson, lesson.id);
    assert.equal(s.overview().scenario, "");
  });

  it("goes back to draft with the generator's problems when a build fails", async () => {
    const { s } = await ready("fail");
    const done = await s.continueBuild(s.beginBuild());
    assert.equal(done.status, "failed");
    assert.deepEqual(done.problems, ["objective o1 has too few items"]);
    assert.equal(s.record()?.status, "draft");
    assert.throws(() => s.draft(), /Nothing has been built/);
  });

  it("refuses a built course that doesn't validate", async () => {
    const { s } = await ready("invalid");
    const done = await s.continueBuild(s.beginBuild());
    assert.equal(done.status, "failed");
    assert.match(done.problems![0]!, /no-such-lesson/);
  });

  it("never lets the key into state, even when an error quotes it", async () => {
    const { s } = await ready("throw");
    const done = await s.continueBuild(s.beginBuild());
    assert.equal(done.status, "failed");
    assert.match(done.problems![0]!, /\[model key\]/);
    assert.ok(!JSON.stringify(s.overview()).includes(KEY));
  });

  it("marks a build cut off by a restart as failed", async () => {
    const { s, sql } = await ready();
    s.beginBuild();
    const restarted = studioService({ ownerModels: ownerModels() }, sql).s;
    assert.equal(restarted.record()?.status, "draft");
    assert.equal(restarted.buildState()?.status, "failed");
    assert.match(restarted.buildState()!.problems![0]!, /interrupted/);
  });
});
