import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUDIO_OBJECTIVES, studioSnapshot } from "../course/fixtures/studio-course.js";
import { drawExam, examSeed } from "./exam.js";
import type { QuizItem } from "./items.js";

const lesson = studioSnapshot().lessons.find((l) => l.id === "cache-hits")!;
const ids = (items: readonly QuizItem[]) => items.map((item) => item.id);
const scoredIds = (items: readonly QuizItem[]) => ids(items.filter((item) => !item.pilot));
const objectiveOf = (id: string) => lesson.quiz.find((item) => item.id === id)!.objective;

describe("drawExam", () => {
  it("shows the whole quiz in quiz order when the lesson has no exam config", () => {
    const { exam: _, ...plain } = lesson;
    assert.deepEqual(ids(drawExam(plain, STUDIO_OBJECTIVES, { seed: 7 })), ids(lesson.quiz));
  });

  it("draws per_objective scored items for each objective, plus one pilot item", () => {
    const drawn = drawExam(lesson, STUDIO_OBJECTIVES, { seed: 1 });
    assert.equal(drawn.length, 3);
    assert.deepEqual(scoredIds(drawn).map(objectiveOf).sort(), ["compute-hit-ratio", "tell-hit-from-miss"]);
    assert.deepEqual(ids(drawn.filter((item) => item.pilot)), ["hits-7"]);

    const two = drawExam({ ...lesson, exam: { per_objective: 2 } }, STUDIO_OBJECTIVES, { seed: 1 });
    assert.equal(scoredIds(two).length, 4);
  });

  it("is deterministic for a seed, and different seeds draw differently", () => {
    assert.deepEqual(ids(drawExam(lesson, STUDIO_OBJECTIVES, { seed: 42 })), ids(drawExam(lesson, STUDIO_OBJECTIVES, { seed: 42 })));
    const draws = new Set(Array.from({ length: 20 }, (_, seed) => ids(drawExam(lesson, STUDIO_OBJECTIVES, { seed })).join(",")));
    assert.ok(draws.size > 5, `only ${draws.size} distinct draws in 20 seeds`);
  });

  it("prefers unseen items, then the least recently seen", () => {
    const seen: string[] = [];
    const draw = (seed: number) => {
      const items = drawExam(lesson, STUDIO_OBJECTIVES, { seen, seed });
      seen.push(...ids(items));
      return scoredIds(items);
    };
    const first = draw(1);
    const second = draw(2);
    const third = draw(3);
    // Three items per objective: three attempts see all six scored items, none twice.
    assert.equal(new Set([...first, ...second, ...third]).size, 6);
    // The fourth attempt gets the items seen longest ago: the first attempt's.
    assert.deepEqual(draw(4).sort(), [...first].sort());
  });

  it("draws items without an objective as if they had one more objective of their own", () => {
    const loose = lesson.quiz.map((item) => (item.id === "hits-1" || item.id === "hits-2" ? { ...item, objective: undefined } : item));
    const drawn = drawExam({ ...lesson, quiz: loose }, STUDIO_OBJECTIVES, { seed: 5 });
    const scored = scoredIds(drawn);
    assert.equal(scored.length, 3);
    assert.equal(scored.filter((id) => id === "hits-1" || id === "hits-2").length, 1);
  });

  it("ignores other lessons' objectives", () => {
    const only = STUDIO_OBJECTIVES.filter((o) => o.lesson !== "cache-hits");
    // Without its own objectives, every scored item is in the one "no objective" group.
    assert.equal(scoredIds(drawExam(lesson, only, { seed: 5 })).length, 1);
  });
});

describe("examSeed", () => {
  it("is stable and depends on every part", () => {
    assert.equal(examSeed("u1", "cache-hits", 1, "1.0.0"), examSeed("u1", "cache-hits", 1, "1.0.0"));
    const seeds = new Set([
      examSeed("u1", "cache-hits", 1, "1.0.0"),
      examSeed("u2", "cache-hits", 1, "1.0.0"),
      examSeed("u1", "eviction", 1, "1.0.0"),
      examSeed("u1", "cache-hits", 2, "1.0.0"),
      examSeed("u1", "cache-hits", 1, "1.1.0"),
    ]);
    assert.equal(seeds.size, 5);
    // Joining with a separator keeps ("ab", "c") and ("a", "bc") apart.
    assert.notEqual(examSeed("ab", "c"), examSeed("a", "bc"));
  });
});
