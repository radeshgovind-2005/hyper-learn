import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLES } from "../auth/identity.js";
import { AccessDenied, COURSE_ROLES, type CourseRole, coursePermissions, mayEnter, type Permission, permissionsOf, requireCoursePermission } from "./access.js";

const ALL: Permission[] = ["learn", "repair", "view_learners", "reset", "manage_roles", "manage_course"];

describe("course access", () => {
  it("keeps the featured course on global roles exactly as before, whatever the course role", () => {
    for (const global of ROLES) {
      for (const course of [null, ...COURSE_ROLES]) {
        assert.deepEqual(coursePermissions({ featured: true, global, course }), permissionsOf(global), `${global}/${course}`);
      }
    }
    assert.deepEqual(permissionsOf("learner"), ["learn"]);
    assert.deepEqual(permissionsOf("instructor"), ["learn", "repair", "view_learners"]);
    assert.deepEqual(permissionsOf("admin"), ["learn", "repair", "view_learners", "reset", "manage_roles"]);
  });

  it("gives studio courses the full matrix: course role, with a global admin override", () => {
    const expected: Record<string, Record<CourseRole | "none", Permission[]>> = {
      learner: {
        owner: ["learn", "repair", "view_learners", "reset", "manage_course"],
        editor: ["learn", "repair", "view_learners"],
        learner: ["learn"],
        none: [],
      },
      instructor: {
        owner: ["learn", "repair", "view_learners", "reset", "manage_course"],
        editor: ["learn", "repair", "view_learners"],
        learner: ["learn"],
        none: [],
      },
      admin: { owner: ALL, editor: ALL, learner: ALL, none: ALL },
    };
    for (const global of ROLES) {
      for (const course of [...COURSE_ROLES, "none"] as const) {
        const access = { featured: false, global, course: course === "none" ? null : course };
        assert.deepEqual(coursePermissions(access), expected[global]![course], `${global}/${course}`);
        assert.equal(mayEnter(access), expected[global]![course].length > 0);
      }
    }
  });

  it("checks one call, with messages fit to show", () => {
    const bob = { userId: "user_bob", role: "learner" as const };
    assert.equal(requireCoursePermission(bob, { featured: false, courseRole: "owner" }, "manage_course"), bob);
    assert.throws(() => requireCoursePermission(bob, { featured: false, courseRole: "editor" }, "manage_course"), /role in this course \(editor\)/);
    assert.throws(() => requireCoursePermission(bob, { featured: false, courseRole: null }, "learn"), /aren't a member/);
    assert.throws(() => requireCoursePermission(bob, { featured: true, courseRole: "owner" }, "repair"), AccessDenied);
    assert.throws(() => requireCoursePermission(null, { featured: false, courseRole: "owner" }, "learn"), /Sign in/);
  });
});
