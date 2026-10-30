import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "../assessment/answers.js";
import { getCourse } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { CourseService } from "./service.js";

// Volume checks: what instructors and learners call must cost a page, not the whole course.

const lesson = getCourse().getLesson("agent-loop")!;
const right = lesson.quiz.map((item) => correctResponse(item));
const wrong = lesson.quiz.map((item) => wrongOptions(item, lesson.id)[0]!.response);
const sure = lesson.quiz.map(() => 2 as const);

describe("at volume", () => {
  it("pages 230 learners 50 at a time, filters and counts in SQL, in bounded time", () => {
    let t = Date.parse("2026-10-29T12:00:00.000Z");
    const s = new CourseService(sqlite(), { now: () => new Date((t += 1000)).toISOString() });
    const N = 230;
    for (let i = 0; i < N; i++) {
      const id = `user_${String(i).padStart(3, "0")}`;
      s.recordProfile({ userId: id, role: "learner", name: `Learner ${i}` });
      s.submitQuiz(id, lesson.id, i % 3 === 0 ? wrong : right, sure);
    }
    const needHelp = Math.ceil(N / 3);

    const started = performance.now();
    const first = s.learners();
    const elapsed = performance.now() - started;
    assert.equal(first.learners.length, 50, "a page, not everyone");
    assert.equal(first.summary.learners, N);
    assert.equal(first.summary.needs_help, needHelp);
    assert.ok(first.summary.common_beliefs.length > 0);
    assert.ok(elapsed < 500, `a page took ${Math.round(elapsed)} ms`);

    const seen = new Set<string>();
    let page = first;
    for (;;) {
      for (const l of page.learners) {
        assert.ok(!seen.has(l.user_id), "no learner twice across pages");
        seen.add(l.user_id);
      }
      if (!page.next_cursor) break;
      page = s.learners({ cursor: page.next_cursor });
    }
    assert.equal(seen.size, N);
    assert.equal(first.learners[0]!.user_id, "user_229", "most recently active first");

    let helped = 0;
    let p = s.learners({ needs_help: true, limit: 200 });
    for (;;) {
      helped += p.learners.length;
      assert.ok(p.learners.every((l) => l.needs_help));
      if (!p.next_cursor) break;
      p = s.learners({ needs_help: true, limit: 200, cursor: p.next_cursor });
    }
    assert.equal(helped, needHelp);
    assert.throws(() => s.learners({ limit: 1000 }));
  });

  it("merges old lesson-time rows per day, keeping every total", () => {
    let t = Date.parse("2026-08-01T09:00:00.000Z");
    const s = new CourseService(sqlite(), { now: () => new Date(t).toISOString() });
    // Six weeks of a learner reading, a report every 5 minutes for an hour a day.
    for (let day = 0; day < 42; day++) {
      t = Date.parse("2026-08-01T09:00:00.000Z") + day * 86_400_000;
      for (let k = 0; k < 12; k++) {
        t += 5 * 60_000;
        s.track("user_ada", "c1", { kind: "lesson", lesson: lesson.id, active_ms: 5 * 60_000 });
      }
    }
    const events = (s as unknown as { events: { forLearner(l: string): { kind: string }[] } }).events.forLearner("user_ada").filter((e) => e.kind === "lesson");
    // On the last day, days older than 30 are one row each (11 of them); the last 31 days keep every report.
    assert.equal(events.length, 11 + 31 * 12, "older days merged to one row each");
    const total = s.myProgress("user_ada").lessons.find((l) => l.lesson === lesson.id)!.active_ms;
    assert.equal(total, 42 * 12 * 5 * 60_000, "the same total time");
  });
});
