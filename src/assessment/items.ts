import { z } from "zod";

// Schemas for quiz items. Every item type is graded in code (src/assessment/grade.ts) into the same
// Grade shape, so analytics never needs to know which type a question was.
// Strict objects reject unknown keys, so a typo in lesson content fails at load time.

export const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "ids must be kebab-case");

/**
 * What a wrong answer reveals. `reveals_gap_in` = the earlier lesson the learner probably missed
 * (absent = a gap in this lesson). `misconception` = the named belief behind the answer, from the
 * course's misconception catalog. Both optional: an untagged wrong answer is noise.
 */
const tags = {
  reveals_gap_in: Slug.optional(),
  misconception: Slug.optional(),
};
export interface WrongAnswerTag {
  reveals_gap_in?: string | undefined;
  misconception?: string | undefined;
}

const OptionSchema = z.strictObject({
  text: z.string().min(1),
  correct: z.boolean().default(false),
  ...tags,
});
export type Option = z.infer<typeof OptionSchema>;

const base = {
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** Pilot items are shown and recorded but not scored, until their item statistics are known. */
  pilot: z.boolean().default(false),
  /** The learning objective this item tests (course `objectives`), when the course defines them. */
  objective: Slug.optional(),
};

/** Pick exactly one option. */
export const SingleChoiceSchema = z.strictObject({
  type: z.literal("single_choice"),
  ...base,
  options: z.array(OptionSchema).min(2),
});

/** Pick every correct option. Partial credit; each wrongly picked option is evidence. */
export const MultiSelectSchema = z.strictObject({
  type: z.literal("multi_select"),
  ...base,
  options: z.array(OptionSchema).min(3),
});

/** An answer, then the reason for it (Treagust's two-tier test). The reason tier names the belief. */
export const TwoTierSchema = z.strictObject({
  type: z.literal("two_tier"),
  ...base,
  options: z.array(OptionSchema).min(2),
  reason_prompt: z.string().min(1),
  reasons: z.array(OptionSchema).min(2),
});

/** Put the steps in order. `steps` are authored in the correct order and shuffled when shown. */
export const OrderingSchema = z.strictObject({
  type: z.literal("ordering"),
  ...base,
  steps: z.array(z.string().min(1)).min(3),
  /** A wrong answer that places step `first` before step `second` (indices into `steps`). */
  patterns: z.array(z.strictObject({ first: z.number().int().min(0), second: z.number().int().min(0), ...tags })).default([]),
});

/** Match each term to its description. Pairs are authored aligned (left[i] ↔ right[i]). */
export const MatchingSchema = z.strictObject({
  type: z.literal("matching"),
  ...base,
  left: z.array(z.string().min(1)).min(2),
  right: z.array(z.string().min(1)).min(2),
  /** A wrong answer that matches left[left] with right[right]. */
  wrong_pairs: z.array(z.strictObject({ left: z.number().int().min(0), right: z.number().int().min(0), ...tags })).default([]),
});

/** Fill the blanks: `text` holds `{{0}}`, `{{1}}`… Answers are compared after normalize(). */
export const ClozeSchema = z.strictObject({
  type: z.literal("cloze"),
  ...base,
  text: z.string().min(1),
  blanks: z
    .array(
      z.strictObject({
        accept: z.array(z.string().min(1)).min(1),
        /** Wrong answers worth naming: a case-insensitive regex over the normalized answer, and one answer it matches. */
        wrong: z.array(z.strictObject({ match: z.string().min(1), example: z.string().min(1), ...tags })).default([]),
      }),
    )
    .min(1),
});

/** Arrange code lines in order; some offered lines are distractors that don't belong. */
export const ParsonsSchema = z.strictObject({
  type: z.literal("parsons"),
  ...base,
  /** The solution, in order. */
  lines: z.array(z.string().min(1)).min(3),
  distractors: z.array(z.strictObject({ text: z.string().min(1), ...tags })).default([]),
});

/** Checks over a JSON answer. Paths are dot-separated ("arguments.city"). */
const JsonCheckSchema = z.strictObject({
  path: z.string().min(1),
  rule: z.union([
    z.strictObject({ equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.strictObject({ type: z.enum(["string", "number", "boolean", "object", "array", "null"]) }),
    z.strictObject({ present: z.literal(true) }),
    z.strictObject({ absent: z.literal(true) }),
  ]),
  /** What failing this check reveals. */
  ...tags,
});
export type JsonCheck = z.infer<typeof JsonCheckSchema>;

/**
 * Write a JSON value, e.g. the tool call a model would emit. Graded by checks in code (no JSON
 * Schema compiler, which needs eval() and doesn't run in Workers). `example` must pass every check.
 */
export const SchemaCompletionSchema = z.strictObject({
  type: z.literal("schema_completion"),
  ...base,
  example: z.string().min(1),
  checks: z.array(JsonCheckSchema).min(1),
  /** What an answer that isn't valid JSON at all reveals. */
  invalid_json: z.strictObject(tags).default({}),
});

/**
 * Explain in your own words. Graded by a model against a rubric, once, when the answer is submitted
 * (src/assessment/short-answer.ts); the stored response records what the grader found, and code scores it.
 * `calibration` holds labelled answers the grader must reproduce before the item is trusted.
 */
export const ShortAnswerSchema = z.strictObject({
  type: z.literal("short_answer"),
  ...base,
  reference_answer: z.string().min(1),
  rubric: z.array(z.strictObject({ id: Slug, description: z.string().min(1), points: z.number().int().min(1).max(3) })).min(1),
  /** Wrong ideas the grader looks for; firing one is a tagged wrong answer. */
  detectors: z.array(z.strictObject({ id: Slug, description: z.string().min(1), ...tags })).default([]),
  calibration: z
    .array(z.strictObject({ answer: z.string().min(1), criteria: z.array(Slug), detectors: z.array(Slug) }))
    .min(2),
});

const ITEM_SCHEMAS = [
  SingleChoiceSchema,
  MultiSelectSchema,
  TwoTierSchema,
  OrderingSchema,
  MatchingSchema,
  ClozeSchema,
  ParsonsSchema,
  SchemaCompletionSchema,
  ShortAnswerSchema,
] as const;

/** An item without a `type` is a single-choice question, so existing quizzes load unchanged. */
export const QuizItemSchema = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" && !("type" in value) ? { ...value, type: "single_choice" } : value,
  z.discriminatedUnion("type", ITEM_SCHEMAS),
);
export type QuizItem = z.infer<typeof QuizItemSchema>;
export type ItemType = QuizItem["type"];
export type ItemOf<T extends ItemType> = Extract<QuizItem, { type: T }>;

export const ITEM_TYPES = ITEM_SCHEMAS.map((schema) => schema.shape.type.value) as ItemType[];

export const QuizSchema = z.array(QuizItemSchema).min(1);

/**
 * A learner's answer, by item type:
 * single_choice → option index · multi_select → option indices · two_tier → [option, reason] ·
 * ordering → step indices in the order placed · matching → right index for each left index ·
 * cloze → one string per blank · parsons → line ids in order (0..lines-1 = solution lines,
 * lines.length + i = distractor i) · schema_completion → JSON text · short_answer → the text plus what the
 * grader found in it.
 */
export type Response = number | number[] | string | string[] | GradedText;

/** A short answer after grading: which rubric criteria it meets and which detectors fired. */
export interface GradedText {
  text: string;
  criteria: string[];
  detectors: string[];
  /** The grade isn't trusted (low confidence, or an answer that tries to instruct the grader): not scored until a human looks. */
  needs_review: boolean;
}

/** How sure the learner was (Certainty of Response Index): 1 = guessing, 3 = sure. */
export type Certainty = 1 | 2 | 3;

/** Every wrong-answer tag an item can produce, wherever it lives in the item. */
export function itemTags(item: QuizItem): WrongAnswerTag[] {
  switch (item.type) {
    case "single_choice":
    case "multi_select":
      return item.options.filter((o) => !o.correct);
    case "two_tier":
      return [...item.options, ...item.reasons].filter((o) => !o.correct);
    case "ordering":
      return item.patterns;
    case "matching":
      return item.wrong_pairs;
    case "cloze":
      return item.blanks.flatMap((blank) => blank.wrong);
    case "parsons":
      return item.distractors;
    case "schema_completion":
      return [...item.checks, item.invalid_json];
    case "short_answer":
      return item.detectors;
  }
}

/** Item-level rules a schema can't express. Returns problems (empty = valid). */
export function checkItem(item: QuizItem): string[] {
  const problems: string[] = [];
  const exactlyOneCorrect = (options: Option[], what: string) => {
    const n = options.filter((o) => o.correct).length;
    if (n !== 1) problems.push(`${what} must have exactly one correct option (has ${n})`);
  };
  const tagOnCorrect = (options: Option[]) => {
    if (options.some((o) => o.correct && (o.reveals_gap_in || o.misconception))) {
      problems.push("the correct option can't reveal a gap or a misconception");
    }
  };

  switch (item.type) {
    case "single_choice":
      exactlyOneCorrect(item.options, "it");
      tagOnCorrect(item.options);
      break;
    case "multi_select":
      if (!item.options.some((o) => o.correct)) problems.push("needs at least one correct option");
      if (item.options.every((o) => o.correct)) problems.push("needs at least one wrong option");
      tagOnCorrect(item.options);
      break;
    case "two_tier":
      exactlyOneCorrect(item.options, "the answer tier");
      exactlyOneCorrect(item.reasons, "the reason tier");
      tagOnCorrect([...item.options, ...item.reasons]);
      break;
    case "ordering":
      for (const p of item.patterns) {
        if (p.first >= item.steps.length || p.second >= item.steps.length) problems.push("pattern index out of range");
        else if (p.first <= p.second) problems.push(`pattern (${p.first} before ${p.second}) is the correct order, not a mistake`);
      }
      break;
    case "matching":
      if (item.left.length !== item.right.length) problems.push("left and right must have the same length");
      for (const p of item.wrong_pairs) {
        if (p.left >= item.left.length || p.right >= item.right.length) problems.push("wrong_pair index out of range");
        else if (p.left === p.right) problems.push(`wrong_pair (${p.left}, ${p.right}) is a correct pair`);
      }
      break;
    case "cloze": {
      const holes = [...item.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      const expected = item.blanks.map((_, i) => i);
      if (holes.length !== expected.length || !expected.every((i) => holes.includes(i))) {
        problems.push(`text must contain {{0}}..{{${item.blanks.length - 1}}} exactly once each`);
      }
      item.blanks.forEach((blank, i) => {
        for (const wrong of blank.wrong) {
          let pattern: RegExp;
          try {
            pattern = new RegExp(wrong.match, "i");
          } catch {
            problems.push(`blank ${i}: invalid regex "${wrong.match}"`);
            continue;
          }
          if (blank.accept.some((answer) => pattern.test(normalize(answer)))) {
            problems.push(`blank ${i}: wrong pattern "${wrong.match}" matches an accepted answer`);
          }
          if (!pattern.test(normalize(wrong.example))) {
            problems.push(`blank ${i}: example "${wrong.example}" doesn't match its pattern "${wrong.match}"`);
          }
        }
      });
      break;
    }
    case "parsons": {
      const solution = new Set(item.lines);
      for (const d of item.distractors) if (solution.has(d.text)) problems.push(`distractor "${d.text}" is also a solution line`);
      break;
    }
    case "short_answer": {
      const criteria = new Set(item.rubric.map((r) => r.id));
      const detectors = new Set(item.detectors.map((d) => d.id));
      if (criteria.size !== item.rubric.length) problems.push("rubric ids must be unique");
      if (detectors.size !== item.detectors.length) problems.push("detector ids must be unique");
      for (const [i, example] of item.calibration.entries()) {
        for (const id of example.criteria) if (!criteria.has(id)) problems.push(`calibration ${i + 1}: unknown criterion "${id}"`);
        for (const id of example.detectors) if (!detectors.has(id)) problems.push(`calibration ${i + 1}: unknown detector "${id}"`);
      }
      if (!item.calibration.some((e) => e.criteria.length === criteria.size && e.detectors.length === 0)) {
        problems.push("calibration needs a full-marks answer");
      }
      for (const d of item.detectors) {
        if (!item.calibration.some((e) => e.detectors.includes(d.id))) problems.push(`calibration has no answer that fires detector "${d.id}"`);
      }
      break;
    }
    case "schema_completion": {
      let example: unknown;
      try {
        example = JSON.parse(item.example);
      } catch {
        problems.push("example is not valid JSON");
        break;
      }
      for (const check of item.checks) {
        if (!passesCheck(example, check)) problems.push(`example fails check on "${check.path}"`);
      }
      break;
    }
  }
  return problems;
}

/** Lowercase, trim, collapse whitespace and drop surrounding punctuation, for comparing typed answers. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'`.,;:!?()]+|[\s"'`.,;:!?()]+$/g, "");
}

/** Reads a dot-separated path from a JSON value; `undefined` if any step is missing. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const jsonType = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

export function passesCheck(value: unknown, { path, rule }: JsonCheck): boolean {
  const found = readPath(value, path);
  if ("equals" in rule) return found === rule.equals;
  if ("type" in rule) return found !== undefined && jsonType(found) === rule.type;
  if ("present" in rule) return found !== undefined;
  return found === undefined;
}
