import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CourseSnapshot, courseFromSnapshot } from "./compile.js";
import { studioSnapshot } from "./fixtures/studio-course.js";

/** The problems courseFromSnapshot reports for a changed copy of the fixture ([] = valid). */
function problems(change: (s: CourseSnapshot) => void): string[] {
  const snapshot = studioSnapshot();
  change(snapshot);
  try {
    courseFromSnapshot(snapshot);
    return [];
  } catch (error) {
    return (error as Error).message.split("\n- ").slice(1);
  }
}
const lesson = (s: CourseSnapshot, id: string) => s.lessons.find((l) => l.id === id)!;
const checkBlock = (s: CourseSnapshot) => {
  const block = lesson(s, "cache-hits").sections[0]!.blocks.find((b) => b.kind === "check");
  if (block?.kind !== "check") throw new Error("fixture has no check");
  return block;
};

describe("objective and check validation", () => {
  it("accepts the fixture", () => {
    assert.deepEqual(problems(() => {}), []);
  });

  it("refuses duplicate objective ids and objectives of unknown lessons", () => {
    assert.deepEqual(
      problems((s) => s.objectives!.push({ ...s.objectives![0]! })),
      ['Duplicate objective id "tell-hit-from-miss"'],
    );
    assert.deepEqual(
      problems((s) => s.objectives!.push({ id: "extra", lesson: "nowhere", statement: "x", sections: [] })),
      ['Objective "extra" belongs to unknown lesson "nowhere"'],
    );
  });

  it("refuses an objective that lists a section of another lesson", () => {
    assert.deepEqual(
      problems((s) => (s.objectives![0]!.sections = ["eviction/lru"])),
      ['Objective "tell-hit-from-miss" lists "eviction/lru", which is not a section of "cache-hits"'],
    );
  });

  it("requires every scored item of a lesson with objectives to name one of its objectives", () => {
    assert.deepEqual(
      problems((s) => delete lesson(s, "cache-hits").quiz[0]!.objective),
      ['Question "hits-1" in "cache-hits" must name one of the lesson\'s objectives'],
    );
    // A pilot item may leave it out.
    assert.deepEqual(problems((s) => delete lesson(s, "cache-hits").quiz.find((q) => q.pilot)!.objective), []);
    assert.deepEqual(
      problems((s) => (lesson(s, "cache-hits").quiz[0]!.objective = "apply-lru")),
      ['Question "hits-1" in "cache-hits": objective "apply-lru" belongs to "eviction", not "cache-hits"'],
    );
    assert.deepEqual(
      problems((s) => (lesson(s, "cache-hits").quiz[0]!.objective = "made-up")),
      ['Question "hits-1" in "cache-hits": unknown objective "made-up"'],
    );
  });

  it("requires 2 × per_objective scored items per objective, so a retake can be fresh", () => {
    const found = problems((s) => (lesson(s, "eviction").exam = { per_objective: 2 }));
    assert.deepEqual(found, [
      'Objective "apply-lru" has 3 scored questions; it needs at least 4',
      'Objective "judge-cache-size" has 3 scored questions; it needs at least 4',
    ]);
  });

  it("refuses an invalid exam config", () => {
    assert.deepEqual(
      problems((s) => (lesson(s, "eviction").exam = { per_objective: 0 })),
      ['Lesson "eviction" has an invalid exam config'],
    );
  });

  it("refuses checks with no single correct option, a tagged correct option, or unknown references", () => {
    assert.deepEqual(
      problems((s) => (checkBlock(s).check.options[1]!.correct = true)),
      [
        'Check "cache-hits/hits-and-misses/k1" must have exactly one correct option (has 2)',
        "Check \"cache-hits/hits-and-misses/k1\": the correct option can't name a misconception",
      ],
    );
    assert.deepEqual(
      problems((s) => (checkBlock(s).check.options[2]!.misconception = "made-up")),
      ['Check "cache-hits/hits-and-misses/k1": unknown misconception "made-up"'],
    );
    assert.deepEqual(
      problems((s) => (checkBlock(s).objective = "made-up")),
      ['Check "cache-hits/hits-and-misses/k1": unknown objective "made-up"'],
    );
  });

  it("keeps applying every existing rule to the pool", () => {
    assert.deepEqual(
      problems((s) => (lesson(s, "eviction").quiz[0]!.id = "hits-1")),
      ['Duplicate question id "hits-1"'],
    );
  });

  it("drops an archived lesson's objectives with it", () => {
    const snapshot = studioSnapshot();
    lesson(snapshot, "invalidation").archived = true;
    // (Its misconceptions must go too: the catalog may only name live lessons, as before.)
    snapshot.misconceptions = snapshot.misconceptions.filter((m) => m.lesson !== "invalidation");
    const course = courseFromSnapshot(snapshot);
    assert.deepEqual([...new Set(course.objectives.map((o) => o.lesson))], ["cache-hits", "eviction"]);
  });
});
