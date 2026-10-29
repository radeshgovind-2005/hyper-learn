import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LearnerEvent } from "../storage/sql.js";
import { beliefsOf, interventionsOf, quizHistory, sessionsOf, timePerLesson } from "./learner.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 29, 9, 0) + minutes * 60_000).toISOString();
const ev = (kind: LearnerEvent["kind"], minutes: number, data: unknown, lesson: string | null = null): LearnerEvent => ({
  learner: "ada",
  kind,
  lesson,
  release: "1.0.0",
  data,
  at: at(minutes),
});
const answer = (minutes: number, lesson: string, passed: boolean, misconceptions: string[], session = "c1") =>
  ev(
    "answer",
    minutes,
    {
      passed,
      score: passed ? 1 : 0.3,
      session,
      items: [{ item_id: "q1", pilot: false, grade: { correct: passed, errors: misconceptions.map((m) => ({ misconception: m })) } }],
    },
    lesson,
  );

describe("sessionsOf", () => {
  it("merges reconnects within 30 minutes and splits on a longer gap", () => {
    const events = [
      ev("session", 0, { event: "start", session: "c1" }),
      ev("lesson", 5, { active_ms: 240_000, session: "c1" }, "agent-loop"),
      ev("session", 10, { event: "end", session: "c1" }),
      ev("session", 12, { event: "start", session: "c2" }), // a refresh: same visit
      answer(20, "agent-loop", false, []),
      ev("session", 25, { event: "end", session: "c2" }),
      ev("session", 120, { event: "start", session: "c3" }), // two hours later: a new visit
      ev("session", 130, { event: "end", session: "c3" }),
    ];
    const sessions = sessionsOf(events);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.duration_ms, 25 * 60_000);
    assert.deepEqual(sessions[0]!.lessons, ["agent-loop"]);
    assert.equal(sessions[0]!.quizzes, 1);
    assert.equal(sessions[1]!.duration_ms, 10 * 60_000);
  });

  it("ends a connection that never closed at its last activity", () => {
    const sessions = sessionsOf([ev("session", 0, { event: "start", session: "c1" }), ev("lesson", 7, { active_ms: 1000, session: "c1" }, "x")]);
    assert.equal(sessions[0]!.duration_ms, 7 * 60_000);
  });
});

describe("learner summaries", () => {
  it("adds up visible time per lesson", () => {
    const events = [ev("lesson", 1, { active_ms: 60_000 }, "a"), ev("lesson", 2, { active_ms: 30_000 }, "a"), ev("lesson", 3, { active_ms: 5_000 }, "b")];
    assert.deepEqual(timePerLesson(events), { a: 90_000, b: 5_000 });
  });

  it("clears a belief once the learner passes that quiz without showing it, and reopens it if it comes back", () => {
    const catalog = [{ id: "model-acts", lesson: "agent-loop", belief: "The model runs actions." }];
    const shown = [answer(0, "agent-loop", false, ["model-acts"]), answer(5, "agent-loop", false, ["model-acts"])];
    assert.deepEqual(
      beliefsOf(shown, catalog).map((b) => [b.id, b.belief, b.times, b.cleared]),
      [["model-acts", "The model runs actions.", 2, false]],
    );
    assert.equal(beliefsOf([...shown, answer(10, "agent-loop", true, [])], catalog)[0]!.cleared, true);
    assert.equal(beliefsOf([...shown, answer(10, "agent-loop", true, []), answer(20, "agent-loop", false, ["model-acts"])], catalog)[0]!.cleared, false);
    assert.equal(beliefsOf([...shown, answer(10, "tool-calling", true, [])], catalog)[0]!.cleared, false, "a pass elsewhere doesn't count");
  });

  it("lists quizzes newest first, and interventions with whether they were completed", () => {
    assert.deepEqual(quizHistory([answer(0, "a", false, []), answer(5, "a", true, [])]).map((q) => q.passed), [true, false]);
    const interventions = interventionsOf([
      ev("intervention", 1, { event: "shown", block_id: "b1", context: "path" }),
      ev("intervention", 2, { event: "completed", block_id: "b1", context: "path" }),
      ev("intervention", 3, { event: "shown", block_id: "b2", context: "preview" }),
    ]);
    assert.deepEqual(interventions.map((i) => [i.block_id, i.completed, i.context]), [["b1", true, "path"], ["b2", false, "preview"]]);
  });
});
