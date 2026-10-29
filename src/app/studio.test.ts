import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqlite } from "../node/sqlite.js";
import type { CourseRole } from "./access.js";
import { CourseService, type DirectoryLink, type ServiceOptions } from "./service.js";

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
