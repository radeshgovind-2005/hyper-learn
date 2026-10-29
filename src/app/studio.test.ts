import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PAGE_CHARS } from "../course/sources.js";
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
    assert.deepEqual(directory.calls, [["course", ID, { title: "Parallel programming", description: "" }]]);
    await assert.rejects(s.updateDetails({ owner: "user_eve" }));
    await assert.rejects(s.updateDetails({ title: "" }), /title/);
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
    assert.deepEqual(lecture, { id: "s1", name: "Lecture 1.pdf", role: null, pages: 2, chars: 21 });
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
