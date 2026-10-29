import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCourse } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { BUILT_IN_COURSES, builtInCourse, type CourseDefinition, FEATURED_COURSE, isBuiltIn } from "./courses.js";
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
