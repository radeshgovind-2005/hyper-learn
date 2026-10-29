import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorsOf, findCycle, randomTopologicalOrder, wouldCreateCycle } from "./graph.js";
import { getCourse } from "./bundle.js";
import { loadCourse } from "./load.js";
import { parseLessonFile, validateCourse } from "./validate.js";
import { ITEM_TYPES, type QuizItem } from "../assessment/items.js";
import type { Lesson } from "./schema.js";

const question = (id: string, gap?: string): QuizItem => ({
  type: "single_choice",
  pilot: false,
  id,
  prompt: "?",
  options: [
    { text: "right", correct: true },
    gap ? { text: "wrong", correct: false, reveals_gap_in: gap } : { text: "wrong", correct: false },
  ],
});

const lesson = (id: string, prerequisites: string[], quiz?: QuizItem[]): Lesson => ({
  id,
  title: id,
  summary: id,
  file: `${id}.md`,
  body: "",
  prerequisites,
  quiz: quiz ?? [question(`${id}-q1`, prerequisites[0])],
});

describe("the agentic-coding course", () => {
  it("loads from Markdown and passes validation", () => {
    assert.equal(loadCourse().lessons.length, 6);
  });

  it("loads from the bundle and passes validation", () => {
    const course = getCourse();
    assert.equal(course.lessons.length, 6);
    assert.deepEqual(course.graph["multi-agent"], ["tool-calling", "structured-output"]);
    for (const l of course.lessons) assert.ok(l.quiz.length >= 3, `${l.id} needs a real quiz`);
  });

  it("names misconceptions for every lesson and uses every item type", () => {
    const course = getCourse();
    for (const l of course.lessons) {
      assert.ok(course.misconceptions.some((m) => m.lesson === l.id), `${l.id} has no named misconception`);
    }
    assert.deepEqual(new Set(course.lessons.flatMap((l) => l.quiz.map((q) => q.type))), new Set(ITEM_TYPES));
  });
});

describe("parseLessonFile", () => {
  const meta = { id: "a", title: "A", summary: "A", file: "a.md", prerequisites: [] };

  it("splits the body from the quiz block", () => {
    const parsed = parseLessonFile(meta, `# A\n\nText.\n\n\`\`\`quiz\n${JSON.stringify([question("q1")])}\n\`\`\`\n`);
    assert.equal(parsed.body, "# A\n\nText.");
    assert.equal(parsed.quiz[0]?.id, "q1");
  });

  it("requires exactly one quiz block", () => {
    assert.throws(() => parseLessonFile(meta, "# A\n\nNo quiz."), /exactly one/);
  });

  it("rejects an unknown field in the quiz", () => {
    const bad = `\`\`\`quiz\n[{"id":"q1","prompt":"?","options":[{"text":"x","correct":true,"hint":"typo"},{"text":"y"}]}]\n\`\`\``;
    assert.throws(() => parseLessonFile(meta, bad), /invalid quiz/);
  });
});

describe("validateCourse", () => {
  const valid = [lesson("a", []), lesson("b", ["a"]), lesson("c", ["b"])];

  it("accepts a valid course", () => {
    assert.deepEqual(validateCourse(valid), []);
  });

  it("reports unknown prerequisites", () => {
    assert.match(validateCourse([lesson("a", []), lesson("b", ["zzz"])]).join(), /unknown prerequisite "zzz"/);
  });

  it("reports cycles", () => {
    const problems = validateCourse([lesson("a", ["b"]), lesson("b", ["a"])]);
    assert.match(problems.join(), /cycle/);
  });

  it("requires exactly one correct option", () => {
    const twoCorrect: QuizItem = {
      type: "single_choice",
      pilot: false,
      id: "q",
      prompt: "?",
      options: [
        { text: "x", correct: true },
        { text: "y", correct: true },
      ],
    };
    assert.match(validateCourse([lesson("a", [], [twoCorrect])]).join(), /exactly one correct option/);
  });

  it("allows a gap tag on a lesson that isn't a prerequisite yet (that's how a missing one shows up)", () => {
    assert.deepEqual(validateCourse([lesson("a", []), lesson("b", ["a"]), lesson("c", [], [question("c-q1", "b")])]), []);
  });

  it("rejects a gap tag on a lesson that depends on this one, or on an unknown lesson", () => {
    const backwards = validateCourse([lesson("a", [], [question("a-q1", "b")]), lesson("b", ["a"])]);
    assert.match(backwards.join(), /reveals_gap_in "b" depends on "a"/);
    assert.match(validateCourse([lesson("a", [], [question("a-q1", "zzz")])]).join(), /"zzz" is not a lesson/);
  });

  it("requires every direct prerequisite to be detectable from some wrong answer", () => {
    const untagged = lesson("b", ["a"], [question("b-q1")]);
    assert.match(validateCourse([lesson("a", []), untagged]).join(), /no wrong option reveals a gap in prerequisite "a"/);
  });
});

describe("misconception tags", () => {
  const tagged = (id: string, prerequisites: string[], option: Record<string, string>): Lesson =>
    lesson(id, prerequisites, [
      {
        type: "single_choice",
        pilot: false,
        id: `${id}-q1`,
        prompt: "?",
        options: [{ text: "right", correct: true }, { text: "wrong", correct: false, ...option }],
      },
    ]);
  const catalog = [{ id: "has-memory", lesson: "a", belief: "The model remembers." }];

  it("accepts a tag that points at the lesson teaching the belief", () => {
    const lessons = [tagged("a", [], { misconception: "has-memory" }), tagged("b", ["a"], { reveals_gap_in: "a", misconception: "has-memory" })];
    assert.deepEqual(validateCourse(lessons, catalog), []);
  });

  it("rejects an unknown misconception", () => {
    assert.match(validateCourse([tagged("a", [], { misconception: "nope" })], catalog).join(), /unknown misconception "nope"/);
  });

  it("requires the answer to point at the misconception's lesson", () => {
    const lessons = [lesson("a", []), tagged("b", ["a"], { reveals_gap_in: "a" }), tagged("c", ["a"], { misconception: "has-memory" })];
    assert.match(validateCourse(lessons, catalog).join(), /belongs to "a", so the answer must point there/);
  });

  it("rejects a misconception no wrong answer reveals", () => {
    assert.match(validateCourse([lesson("a", [])], catalog).join(), /"has-memory" is never revealed/);
  });
});

describe("graph helpers", () => {
  const graph = { a: [], b: ["a"], c: ["b"], d: ["a"] };

  it("finds ancestors transitively", () => {
    assert.deepEqual([...ancestorsOf(graph, "c")].sort(), ["a", "b"]);
  });

  it("detects cycles and would-be cycles", () => {
    assert.equal(findCycle(graph), null);
    assert.ok(findCycle({ a: ["c"], b: ["a"], c: ["b"] }));
    assert.equal(wouldCreateCycle(graph, "a", "c"), true);
    assert.equal(wouldCreateCycle(graph, "d", "b"), false);
  });

  it("orders prerequisites first, whatever the random choices", () => {
    for (const r of [0, 0.5, 0.99]) {
      const order = randomTopologicalOrder(graph, () => r);
      for (const [id, prereqs] of Object.entries(graph)) {
        for (const p of prereqs) assert.ok(order.indexOf(p) < order.indexOf(id), `${p} before ${id}`);
      }
    }
  });
});
