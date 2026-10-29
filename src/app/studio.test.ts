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
