import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse } from "./answers.js";
import { getCourse } from "../course/bundle.js";
import { type CheckBlock, type CourseSnapshot } from "../course/compile.js";
import { gradeItem } from "./grade.js";
import type { QuizItem } from "./items.js";
import { sqlite } from "../node/sqlite.js";
import { CourseService } from "../app/service.js";
import { correctIsLongest, studioChecks } from "../generate/checks.js";
import { fromLearnerResponse, learnerItem, learnerSnapshot, permutation } from "./view.js";

// Learners never receive answer keys: not in the snapshot, not in the exam. Grading stays on the server.

const course = getCourse();
const items: QuizItem[] = course.lessons.flatMap((l) => l.quiz);
const SALT = "test-salt";

/** How many entries an item's ordered part has (0 when its order isn't the answer). */
const orderLength = (item: QuizItem) =>
  item.type === "ordering" ? item.steps.length : item.type === "matching" ? item.right.length : item.type === "parsons" ? item.lines.length + item.distractors.length : 0;

/** Everything in the snapshot except intervention blocks (unscored practice that the UI checks itself). */
const withoutInterventions = (snapshot: CourseSnapshot) => ({
  ...snapshot,
  lessons: snapshot.lessons.map((l) => ({ ...l, sections: l.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => b.kind !== "intervention") })) })),
});

describe("the learner's view of a question", () => {
  it("covers every question type the course has", () => {
    assert.deepEqual(new Set(items.map((i) => i.type)).size, 9);
  });

  it("carries no key: no correct flags, tags, accepted answers, rubrics or examples", () => {
    for (const item of items) {
      const json = JSON.stringify(learnerItem(item, SALT));
      for (const key of ['"correct"', '"misconception"', '"reveals_gap_in"', '"match"', '"description"']) {
        assert.ok(!json.includes(key), `${item.type} ${item.id} leaks ${key}`);
      }
      if (item.type === "cloze") for (const b of item.blanks) for (const a of b.accept) assert.ok(!json.includes(JSON.stringify(a)), `cloze leaks "${a}"`);
      if (item.type === "short_answer") assert.ok(!json.includes(item.reference_answer.slice(0, 20)));
      if (item.type === "schema_completion") assert.ok(!json.includes(item.example.slice(0, 20)));
    }
  });

  it("shuffles ordered answers by the salt, and maps a learner's answer back so it grades the same", () => {
    for (const item of items.filter((i) => i.type === "ordering" || i.type === "matching" || i.type === "parsons")) {
      const view = learnerItem(item, SALT);
      const order = permutation(orderLength(item), `${SALT}:${item.id}`);
      // The right answer, expressed on the view: positions in the shuffled list.
      const right = correctResponse(item) as number[];
      const onView = right.map((i) => (i < 0 ? i : order.indexOf(i)));
      assert.deepEqual(fromLearnerResponse(item, onView, SALT), right);
      assert.ok(gradeItem(item, fromLearnerResponse(item, onView, SALT), "x").correct, `${item.id} grades right after mapping`);
      // Without mapping, the authored order isn't what the view shows (for this salt).
      if (view.type === "ordering" && item.type === "ordering") assert.notDeepEqual(view.steps, item.steps);
    }
    assert.notDeepEqual(permutation(8, "a:x"), permutation(8, "b:x"), "another salt, another order");
  });
});

describe("learner snapshots and exams", () => {
  it("strip the key from quiz items and practice checks; owners still get it", () => {
    const s = new CourseService(sqlite(), { now: () => "2026-11-01T12:00:00.000Z" });
    const full = s.snapshot();
    const view = s.learnerSnapshot();
    const json = JSON.stringify(withoutInterventions(view));
    assert.ok(!json.includes('"correct"'), "no correct flag");
    const checks = full.lessons.flatMap((l) => l.sections.flatMap((x) => x.blocks.filter((b): b is CheckBlock => b.kind === "check")));
    for (const feedback of checks.flatMap((c) => c.check.options.map((o) => o.feedback))) {
      assert.ok(!json.includes(JSON.stringify(feedback)), `feedback "${feedback.slice(0, 30)}" leaks`);
    }
    assert.ok(JSON.stringify(full).includes('"correct"'), "the full snapshot keeps the key");
    assert.equal(s.learnerSnapshot(), view, "made once per release");
    assert.equal(learnerSnapshot(full, "x").lessons.length, full.lessons.length);
  });

  it("a learner answering on the view is graded as on the real question", () => {
    const s = new CourseService(sqlite(), { now: () => "2026-11-01T12:00:00.000Z" });
    const lesson = course.getLesson("agent-loop")!;
    const salt = (s as unknown as { itemSalt(): string }).itemSalt();
    const exam = s.exam("user_bob", lesson.id, true);
    assert.ok(!JSON.stringify(exam).includes('"correct"'));
    const answers = lesson.quiz.map((item) => {
      const right = correctResponse(item);
      if (!Array.isArray(right) || orderLength(item) === 0) return right;
      const order = permutation(orderLength(item), `${salt}:${item.id}`);
      return (right as number[]).map((i) => (i < 0 ? i : order.indexOf(i)));
    });
    const result = s.submitQuiz("user_bob", lesson.id, answers, lesson.quiz.map(() => 3 as const), undefined, undefined, true);
    assert.ok(result.passed, "every answer right");
    // The same answers without `view` are judged on the authored order, and the ordered ones are wrong.
    const other = s.submitQuiz("user_eve", lesson.id, answers, lesson.quiz.map(() => 3 as const));
    const ordered = lesson.quiz.filter((i) => ["ordering", "matching", "parsons"].includes(i.type)).length;
    if (ordered > 0) assert.ok(other.items.some((i) => !i.grade.correct));
  });
});

describe("answers given away by length", () => {
  const check = (id: string, longest: boolean) => ({
    id,
    kind: "check" as const,
    archived: false,
    check: {
      prompt: "Which is true?",
      options: [
        { text: longest ? "The right answer, spelled out at much greater length than the rest" : "Right", correct: true, misconception: null, feedback: "Yes." },
        { text: "A wrong answer", correct: false, misconception: null, feedback: "No." },
        { text: "Another wrong one", correct: false, misconception: null, feedback: "No." },
      ],
    },
  });
  const snapshot = (longest: boolean[]): CourseSnapshot => ({
    course_id: "c",
    title: "C",
    version: "1.0.0",
    misconceptions: [],
    lessons: [
      {
        id: "l1",
        title: "L1",
        summary: "",
        prerequisites: [],
        archived: false,
        quiz: [],
        sections: longest.map((l, i) => ({ id: `l1/s${i}`, title: `S${i}`, archived: false, blocks: [check(`l1/s${i}/k1`, l)] })),
      },
    ],
  });

  it("rejects a lesson where most right answers are the longest option, naming each", () => {
    const problems = studioChecks(snapshot([true, true, true, false]), []);
    assert.equal(problems.length, 3);
    assert.deepEqual(problems.map((p) => p.section), ["l1/s0", "l1/s1", "l1/s2"]);
    assert.match(problems[0]!.message, /longest option .* make the wrong options as long and specific/);
  });

  it("allows it in a few questions, and in a lesson with a single question", () => {
    assert.deepEqual(studioChecks(snapshot([true, false, true, false]), []), []);
    assert.deepEqual(studioChecks(snapshot([true]), []), []);
    assert.ok(correctIsLongest([{ text: "long right answer", correct: true }, { text: "short", correct: false }]));
    assert.ok(!correctIsLongest([{ text: "same", correct: true }, { text: "same", correct: false }]));
  });
});
