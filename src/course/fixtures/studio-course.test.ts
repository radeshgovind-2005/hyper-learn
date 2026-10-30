import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LEARNER_MODEL, simulate } from "../../simulation/learners.js";
import { courseFromSnapshot, isTextBlock } from "../compile.js";
import { citedPage } from "../sources.js";
import { STUDIO_MISSING_PREREQ, STUDIO_SOURCES, studioSnapshot } from "./studio-course.js";

describe("the studio fixture course", () => {
  const snapshot = studioSnapshot();
  const course = courseFromSnapshot(snapshot);

  it("passes validation, with objectives and an exam config on every lesson", () => {
    assert.equal(course.lessons.length, 3);
    assert.equal(course.objectives.length, 6);
    for (const lesson of course.lessons) assert.deepEqual(lesson.exam, { per_objective: 1 });
  });

  it("has a pool deep enough for a fresh retake: at least 2 × per_objective + 1 scored items per objective", () => {
    for (const objective of course.objectives) {
      const lesson = course.getLesson(objective.lesson)!;
      const n = lesson.quiz.filter((item) => !item.pilot && item.objective === objective.id).length;
      assert.ok(n >= 2 * lesson.exam!.per_objective + 1, `${objective.id} has ${n} items`);
    }
  });

  it("ends every section with a check, and every text block cites a real page", () => {
    for (const section of snapshot.lessons.flatMap((l) => l.sections)) {
      assert.equal(section.blocks.at(-1)?.kind, "check", section.id);
      for (const block of section.blocks.filter(isTextBlock)) {
        assert.ok(block.cites?.length, `${block.id} cites nothing`);
        for (const c of block.cites!) assert.ok(citedPage(STUDIO_SOURCES, c), `${block.id} cites a missing page`);
      }
    }
  });

  it("returns a fresh copy each time", () => {
    const a = studioSnapshot();
    a.lessons[0]!.title = "changed";
    assert.equal(studioSnapshot().lessons[0]!.title, "Hits and misses");
  });

  it("can be simulated", () => {
    const { attempts } = simulate(course, STUDIO_MISSING_PREREQ, { model: { ...DEFAULT_LEARNER_MODEL, learners: 40 } });
    assert.equal(attempts.length, 3 * 40);
  });
});
