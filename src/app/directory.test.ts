import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqlite } from "../node/sqlite.js";
import { FEATURED_COURSE } from "./courses.js";
import { DirectoryService, MAX_COURSES_PER_OWNER } from "./directory.js";

const NOW = "2026-10-29T12:00:00.000Z";
const directory = () => {
  let n = 0;
  return new DirectoryService(sqlite(), { now: () => NOW, newId: () => `c-${String(++n).padStart(12, "0")}` });
};

describe("DirectoryService", () => {
  it("creates a draft course owned by its creator, and lists it as theirs", () => {
    const d = directory();
    const course = d.createCourse("user_ada", { title: "  Parallel computing ", description: "MPI and OpenMP" });
    assert.equal(course.title, "Parallel computing");
    assert.equal(course.status, "draft");
    assert.equal(d.exists(course.id), true);
    const mine = d.myCourses("user_ada");
    assert.deepEqual(mine.owned.map((c) => [c.id, c.role]), [[course.id, "owner"]]);
    assert.deepEqual(mine.shared, []);
    assert.deepEqual(mine.featured.map((c) => c.id), [FEATURED_COURSE]);
    assert.ok(!("owner" in mine.owned[0]!), "cards don't carry the owner's user id");
  });

  it("refuses bad details, unknown fields and too many courses", () => {
    const d = directory();
    assert.throws(() => d.createCourse("user_ada", { title: "  " }), /title/);
    assert.throws(() => d.createCourse("user_ada", { title: "x".repeat(121) }));
    assert.throws(() => d.createCourse("user_ada", { title: "ok", owner: "user_eve" }));
    for (let i = 0; i < MAX_COURSES_PER_OWNER; i++) d.createCourse("user_ada", { title: `c${i}` });
    assert.throws(() => d.createCourse("user_ada", { title: "one more" }), /already own/);
    assert.ok(d.createCourse("user_bob", { title: "bob's" }));
  });

  it("follows membership and status changes reported by course objects", () => {
    const d = directory();
    const { id } = d.createCourse("user_ada", { title: "Course" });
    d.membershipChanged(id, "user_bob", "learner");
    d.courseUpdated(id, { status: "published", title: "Renamed" });
    assert.deepEqual(d.myCourses("user_bob").shared.map((c) => [c.title, c.role, c.status]), [["Renamed", "learner", "published"]]);
    d.membershipChanged(id, "user_bob", "editor");
    assert.equal(d.myCourses("user_bob").shared[0]?.role, "editor");
    d.membershipChanged(id, "user_bob", null);
    assert.deepEqual(d.myCourses("user_bob").shared, []);

    assert.throws(() => d.membershipChanged(id, "user_bob", "admin"));
    assert.throws(() => d.membershipChanged("c-nope00000000", "user_bob", "learner"), /No course/);
    assert.throws(() => d.courseUpdated(id, { status: "deleted" }));
    assert.throws(() => d.courseUpdated(id, { owner: "user_eve" }));
  });

  it("lets only the owner or a global admin delete a course, never a built-in one", () => {
    const d = directory();
    const { id } = d.createCourse("user_ada", { title: "Course" });
    d.membershipChanged(id, "user_bob", "editor");
    d.membershipChanged(id, "user_cy", "learner");
    assert.throws(() => d.deletable({ userId: "user_bob", role: "learner" }, id), /Only the course's owner/, "an editor can't");
    assert.throws(() => d.deletable({ userId: "user_cy", role: "instructor" }, id), /Only the course's owner/, "nor a learner, whatever their global role");
    assert.throws(() => d.deletable({ userId: "user_eve", role: "learner" }, id), /Only the course's owner/);
    assert.throws(() => d.deletable({ userId: "user_ada", role: "learner" }, "c-nope00000000"), /No such course/);
    assert.throws(() => d.deletable({ userId: "user_ada", role: "learner" }, 42), /No such course/);
    assert.throws(() => d.deletable({ userId: "user_root", role: "admin" }, FEATURED_COURSE), /Built-in courses can't be deleted/);
    assert.equal(d.deletable({ userId: "user_ada", role: "learner" }, id).id, id);
    assert.equal(d.deletable({ userId: "user_root", role: "admin" }, id).id, id);
  });

  it("forgets a deleted course and everyone's membership, so the owner can create another", () => {
    const d = directory();
    for (let i = 0; i < MAX_COURSES_PER_OWNER; i++) d.createCourse("user_ada", { title: `c${i}` });
    const { id } = d.myCourses("user_ada").owned[0]!;
    d.membershipChanged(id, "user_bob", "learner");
    assert.throws(() => d.createCourse("user_ada", { title: "one more" }), /delete one/);
    d.remove(d.deletable({ userId: "user_ada", role: "learner" }, id).id);
    assert.equal(d.exists(id), false);
    assert.deepEqual(d.myCourses("user_bob").shared, []);
    assert.equal(d.myCourses("user_ada").owned.length, MAX_COURSES_PER_OWNER - 1);
    assert.ok(d.createCourse("user_ada", { title: "one more" }));
  });

  it("forgets a course whose object couldn't be initialised", () => {
    const d = directory();
    const { id } = d.createCourse("user_ada", { title: "Course" });
    d.remove(id);
    assert.equal(d.exists(id), false);
    assert.deepEqual(d.myCourses("user_ada").owned, []);
  });
});
