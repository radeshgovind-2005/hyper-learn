import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctResponse, wrongOptions } from "./answers.js";
import { gradeItem } from "./grade.js";
import { checkItem, ITEM_TYPES, itemTags, normalize, type QuizItem, QuizItemSchema } from "./items.js";

const L = "agent-loop";
const item = (raw: unknown): QuizItem => QuizItemSchema.parse(raw);

const FIXTURES: QuizItem[] = [
  item({
    id: "sc",
    prompt: "Who runs the action?",
    options: [
      { text: "The harness", correct: true },
      { text: "The model", misconception: "model-executes-actions" },
      { text: "The API keeps state", reveals_gap_in: "llm-basics", misconception: "llm-has-memory" },
      { text: "Nobody" },
    ],
  }),
  item({
    type: "multi_select",
    id: "ms",
    prompt: "Which are the harness's job?",
    options: [
      { text: "Run tools", correct: true },
      { text: "Append results", correct: true },
      { text: "Predict tokens", misconception: "model-executes-actions" },
      { text: "Nothing" },
    ],
  }),
  item({
    type: "two_tier",
    id: "tt",
    prompt: "Does the model run the tool?",
    options: [{ text: "No", correct: true }, { text: "Yes" }],
    reason_prompt: "Because…",
    reasons: [
      { text: "It only emits a request", correct: true },
      { text: "It executes code in its weights", misconception: "model-executes-actions" },
    ],
  }),
  item({
    type: "ordering",
    id: "or",
    prompt: "Order the loop",
    steps: ["decide", "act", "observe"],
    patterns: [{ first: 2, second: 1, misconception: "observe-before-act" }],
  }),
  item({
    type: "matching",
    id: "ma",
    prompt: "Match",
    left: ["model", "harness", "tool"],
    right: ["decides", "executes", "does the work"],
    wrong_pairs: [{ left: 0, right: 1, misconception: "model-executes-actions" }],
  }),
  item({
    type: "cloze",
    id: "cl",
    prompt: "Fill in",
    text: "The {{0}} runs the action.",
    blanks: [{ accept: ["harness", "program"], wrong: [{ match: "^(the )?model$", example: "model", misconception: "model-executes-actions" }] }],
  }),
  item({
    type: "parsons",
    id: "pa",
    prompt: "Build the loop",
    lines: ["for (let i = 0; i < MAX; i++) {", "  const step = await model(messages);", "}"],
    distractors: [{ text: "while (true) {", misconception: "loop-always-terminates" }],
  }),
  item({
    type: "schema_completion",
    id: "js",
    prompt: "Write the tool call",
    example: '{"name":"get_weather","arguments":{"city":"Paris"}}',
    checks: [
      { path: "name", rule: { equals: "get_weather" } },
      { path: "arguments.city", rule: { type: "string" } },
      { path: "result", rule: { absent: true }, misconception: "model-executes-actions" },
    ],
    invalid_json: { misconception: "json-unreadable" },
  }),
];

describe("quiz item schemas", () => {
  it("has a fixture for every item type", () => {
    assert.deepEqual(new Set(FIXTURES.map((f) => f.type)), new Set(ITEM_TYPES));
  });

  it("treats an item without a type as single_choice", () => {
    assert.equal(FIXTURES[0]!.type, "single_choice");
  });

  it("passes checkItem for every fixture", () => {
    for (const fixture of FIXTURES) assert.deepEqual(checkItem(fixture), [], fixture.id);
  });

  it("rejects unknown fields", () => {
    assert.throws(() => item({ id: "x", prompt: "?", options: [{ text: "a", correct: true, hint: "typo" }, { text: "b" }] }));
  });

  it("catches content mistakes a schema can't", () => {
    const problems = (raw: unknown) => checkItem(item(raw)).join();
    assert.match(problems({ id: "x", prompt: "?", options: [{ text: "a" }, { text: "b" }] }), /exactly one correct/);
    assert.match(
      problems({ type: "ordering", id: "x", prompt: "?", steps: ["a", "b", "c"], patterns: [{ first: 0, second: 1 }] }),
      /is the correct order/,
    );
    assert.match(
      problems({ type: "cloze", id: "x", prompt: "?", text: "no blank", blanks: [{ accept: ["a"] }] }),
      /must contain \{\{0\}\}/,
    );
    assert.match(
      problems({
        type: "cloze",
        id: "x",
        prompt: "?",
        text: "{{0}}",
        blanks: [{ accept: ["harness"], wrong: [{ match: "har", example: "model" }] }],
      }),
      /matches an accepted answer/,
    );
    assert.match(
      problems({
        type: "schema_completion",
        id: "x",
        prompt: "?",
        example: '{"a":1}',
        checks: [{ path: "a", rule: { equals: 2 } }],
      }),
      /example fails check/,
    );
  });
});

describe("gradeItem", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.type}: the correct response scores 1 with no errors`, () => {
      assert.deepEqual(gradeItem(fixture, correctResponse(fixture), L), { score: 1, correct: true, errors: [] });
    });

    it(`${fixture.type}: every tagged wrong answer is reachable and graded as what it reveals`, () => {
      const options = wrongOptions(fixture, L);
      assert.ok(options.length > 0);
      for (const { reveals, response } of options) {
        const grade = gradeItem(fixture, response, L);
        assert.equal(grade.correct, false);
        assert.ok(grade.score < 1);
        assert.ok(grade.errors.some((e) => e.misconception === reveals.misconception && e.points_to === reveals.points_to));
      }
      const reachable = new Set(options.map((o) => o.reveals.misconception));
      for (const tag of itemTags(fixture)) {
        if (tag.misconception) assert.ok(reachable.has(tag.misconception), `${tag.misconception} unreachable`);
      }
    });
  }

  it("points a wrong answer at the gap it reveals, or at the item's own lesson", () => {
    const sc = FIXTURES[0]!;
    assert.deepEqual(gradeItem(sc, 2, L).errors, [{ points_to: "llm-basics", misconception: "llm-has-memory" }]);
    assert.deepEqual(gradeItem(sc, 3, L).errors, [{ points_to: L }]);
  });

  it("gives partial credit on multi_select, ordering, matching and schema_completion", () => {
    const [, ms, , or, ma, , , js] = FIXTURES;
    assert.equal(gradeItem(ms!, [0], L).score, 0.5);
    assert.equal(gradeItem(or!, [0, 2, 1], L).score, 2 / 3);
    assert.equal(gradeItem(ma!, [1, 0, 2], L).score, 1 / 3);
    assert.equal(gradeItem(js!, '{"name":"get_weather","arguments":{"city":"Paris"},"result":"18C"}', L).score, 2 / 3);
  });

  it("counts a two-tier answer right only when the reason is right too", () => {
    const tt = FIXTURES[2]!;
    assert.equal(gradeItem(tt, [0, 1], L).score, 0);
    assert.deepEqual(gradeItem(tt, [0, 1], L).errors, [{ points_to: L, misconception: "model-executes-actions" }]);
  });

  it("normalizes typed answers before comparing", () => {
    assert.equal(normalize("  The   Harness. "), "the harness");
    assert.equal(gradeItem(FIXTURES[5]!, ["  Harness. "], L).correct, true);
    assert.deepEqual(gradeItem(FIXTURES[5]!, ["The model"], L).errors, [{ points_to: L, misconception: "model-executes-actions" }]);
  });

  it("names invalid JSON and missing fields in schema_completion", () => {
    const js = FIXTURES[7]!;
    assert.deepEqual(gradeItem(js, "get_weather(Paris)", L).errors, [{ points_to: L, misconception: "json-unreadable" }]);
    assert.equal(gradeItem(js, '{"name":"get_weather"}', L).errors.length, 1);
  });

  it("throws on a malformed response", () => {
    assert.throws(() => gradeItem(FIXTURES[0]!, 9, L), /Invalid response/);
    assert.throws(() => gradeItem(FIXTURES[3]!, [0, 0, 1], L), /permutation/);
    assert.throws(() => gradeItem(FIXTURES[5]!, "harness", L), /expected 1 strings/);
  });
});
