import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCourse } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { BUILT_IN_COURSES, builtInCourse, type CourseDefinition, DIRECTORY_NAME, FEATURED_COURSE, isBuiltIn, isStudioId, newCourseId, routeAllowed } from "./courses.js";
import { CourseService } from "./service.js";

const NOW = "2026-10-29T12:00:00.000Z";
const featured = () => builtInCourse(FEATURED_COURSE)!;
const service = (course: CourseDefinition) => new CourseService(sqlite(), { course, now: () => NOW, newId: () => "run-1" });

describe("course definitions", () => {
  it("has the featured course built in, and nothing else by accident", () => {
    assert.deepEqual(BUILT_IN_COURSES, [FEATURED_COURSE]);
    for (const id of ["constructor", "__proto__", "toString", "", "Agentic-Coding"]) assert.equal(isBuiltIn(id), false, id);
    assert.equal(featured().scenarios.length > 0, true);
    assert.notEqual(featured().base, featured().base, "each caller gets its own copy");
  });

  it("runs the featured course from its definition exactly as before", () => {
    const s = service(featured());
    assert.equal(s.overview().scenario, "dominant-misconception");
    assert.deepEqual(s.course().lessons.map((l) => l.id), getCourse().lessons.map((l) => l.id));
  });

  it("ends a reference run that needs an exemplar the course lacks with a clear step, not an error", async () => {
    const s = service({ ...featured(), exemplars: [] });
    const run = await s.startRun({ mode: "autopilot", agents: false });
    assert.equal(run.status, "done");
    assert.equal(run.error, undefined);
    assert.equal(run.steps.at(-1)?.title, "Needs a model to write this");
    assert.deepEqual(s.overview().releases.map((r) => r.version), ["1.0.0"]);
  });

  it("offers scenario features only to a course that has scenarios", async () => {
    const s = service({ id: "plain", base: featured().base, scenarios: [], exemplars: [] });
    const overview = s.overview();
    assert.equal(overview.scenario, "");
    assert.deepEqual(overview.scenarios, []);
    assert.throws(() => s.beginRun({ mode: "hitl", agents: false }), /no simulated learners/);
    const real = await s.startRun({ mode: "hitl", agents: false, source: "real" });
    assert.match(real.steps[0]!.title, /No quiz answers/);
    s.reset("anything");
    assert.deepEqual(s.overview().releases.map((r) => r.version), ["1.0.0"]);
  });
});

describe("which objects may exist", () => {
  const created = new Set(["c-abcdefghijkl"]);
  const exists = async (id: string) => created.has(id);
  const allowed = (className: string, name: string) => routeAllowed({ className, name }, exists);

  it("lets through built-in courses, created studio courses and the one directory", async () => {
    assert.equal(await allowed("CourseAgent", FEATURED_COURSE), true);
    assert.equal(await allowed("CourseAgent", "c-abcdefghijkl"), true);
    assert.equal(await allowed("DirectoryAgent", DIRECTORY_NAME), true);
  });

  it("refuses everything else without asking the directory about malformed ids", async () => {
    let asked = 0;
    const counting = async (id: string) => (asked++, created.has(id));
    for (const [className, name] of [
      ["CourseAgent", "c-unknownunkno"],
      ["CourseAgent", "agentic-coding2"],
      ["CourseAgent", "../agentic-coding"],
      ["CourseAgent", "C-ABCDEFGHIJKL"],
      ["DirectoryAgent", "other"],
      ["DirectoryAgent", FEATURED_COURSE],
      ["OtherAgent", FEATURED_COURSE],
    ] as const) {
      assert.equal(await routeAllowed({ className, name }, counting), false, `${className}/${name}`);
    }
    assert.equal(asked, 1, "only the well-formed unknown id reaches the directory");
  });

  it("makes well-formed, distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, newCourseId));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.equal(isStudioId(id), true, id);
  });
});
