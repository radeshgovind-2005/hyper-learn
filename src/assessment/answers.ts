import { gradeItem, type WrongAnswer } from "./grade.js";
import { type JsonCheck, type QuizItem, readPath, type Response, type WrongAnswerTag } from "./items.js";

// Concrete responses for every item type: the correct one, and one per way of being wrong.
// The learner simulation picks among these, so the real graders run on simulated data too.

/** One way to answer an item wrongly, and the wrong answer it reveals when graded. */
export interface WrongOption {
  reveals: WrongAnswer;
  response: Response;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const swap = (order: number[], i: number, j: number) => {
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};
const reveals = (lessonId: string, tag: WrongAnswerTag = {}): WrongAnswer => ({
  points_to: tag.reveals_gap_in ?? lessonId,
  ...(tag.misconception && { misconception: tag.misconception }),
});

/** The response that grades as fully correct. */
export function correctResponse(item: QuizItem): Response {
  switch (item.type) {
    case "single_choice":
      return item.options.findIndex((o) => o.correct);
    case "multi_select":
      return item.options.flatMap((o, i) => (o.correct ? [i] : []));
    case "two_tier":
      return [item.options.findIndex((o) => o.correct), item.reasons.findIndex((o) => o.correct)];
    case "ordering":
      return range(item.steps.length);
    case "matching":
      return range(item.left.length);
    case "cloze":
      return item.blanks.map((blank) => blank.accept[0]!);
    case "parsons":
      return range(item.lines.length);
    case "schema_completion":
      return item.example;
    case "short_answer": {
      const full = item.calibration.find((e) => e.criteria.length === item.rubric.length && e.detectors.length === 0)!;
      return { text: full.answer, criteria: full.criteria, detectors: full.detectors, needs_review: false };
    }
  }
}

/** A JSON value with `path` set to `next`, or removed when `next` is undefined. */
function withPath(value: unknown, path: string, next: unknown): unknown {
  const root = structuredClone(value) as Record<string, unknown>;
  const keys = path.split(".");
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (next === undefined) delete node[last];
  else node[last] = next;
  return root;
}

/** The example answer, changed so that `check` fails. */
function breakCheck(example: unknown, check: JsonCheck): unknown {
  const { rule, path } = check;
  if ("equals" in rule) return withPath(example, path, rule.equals === "wrong-value" ? "other-value" : "wrong-value");
  if ("type" in rule) return withPath(example, path, rule.type === "string" ? 0 : "wrong-type");
  if ("present" in rule) return withPath(example, path, undefined);
  return withPath(example, path, readPath(example, path) ?? "unexpected");
}

/**
 * Every distinct way to answer `item` wrongly: one per tagged wrong answer, plus an untagged one where
 * the type allows it. Each response, when graded, includes the wrong answer it claims to reveal.
 */
export function wrongOptions(item: QuizItem, lessonId: string): WrongOption[] {
  const options: WrongOption[] = [];
  const add = (tag: WrongAnswerTag | undefined, response: Response) => options.push({ reveals: reveals(lessonId, tag), response });

  switch (item.type) {
    case "single_choice":
      item.options.forEach((o, i) => !o.correct && add(o, i));
      break;
    case "multi_select": {
      const correct = correctResponse(item) as number[];
      item.options.forEach((o, i) => !o.correct && add(o, [...correct, i]));
      add(undefined, correct.slice(1)); // missed a correct option
      break;
    }
    case "two_tier": {
      const [a, r] = correctResponse(item) as [number, number];
      item.options.forEach((o, i) => !o.correct && add(o, [i, r]));
      item.reasons.forEach((o, i) => !o.correct && add(o, [a, i]));
      break;
    }
    case "ordering": {
      const solution = range(item.steps.length);
      for (const p of item.patterns) add(p, swap(solution, p.first, p.second));
      const untagged = solution
        .slice(0, -1)
        .find((i) => !item.patterns.some((p) => p.first === i + 1 && p.second === i));
      if (untagged !== undefined) add(undefined, swap(solution, untagged, untagged + 1));
      break;
    }
    case "matching": {
      const solution = range(item.left.length);
      for (const p of item.wrong_pairs) add(p, swap(solution, p.left, p.right));
      const tagged = (i: number, j: number) => item.wrong_pairs.some((p) => (p.left === i && p.right === j) || (p.left === j && p.right === i));
      const pair = solution.flatMap((i) => solution.filter((j) => j > i && !tagged(i, j)).map((j) => [i, j] as const))[0];
      if (pair) add(undefined, swap(solution, pair[0], pair[1]));
      break;
    }
    case "cloze": {
      const correct = correctResponse(item) as string[];
      item.blanks.forEach((blank, i) => {
        for (const w of blank.wrong) add(w, correct.map((answer, j) => (j === i ? w.example : answer)));
      });
      add(undefined, correct.map((answer, j) => (j === 0 ? "no idea" : answer)));
      break;
    }
    case "parsons": {
      const solution = range(item.lines.length);
      item.distractors.forEach((d, i) => add(d, [...solution, item.lines.length + i]));
      add(undefined, swap(solution, 0, 1));
      break;
    }
    case "short_answer":
      // Simulated learners answer with the item's labelled calibration answers, graded as labelled.
      for (const e of item.calibration) {
        if (e.criteria.length === item.rubric.length && e.detectors.length === 0) continue;
        const fired = item.detectors.find((d) => e.detectors.includes(d.id));
        add(fired, { text: e.answer, criteria: e.criteria, detectors: e.detectors, needs_review: false });
      }
      break;
    case "schema_completion": {
      const example: unknown = JSON.parse(item.example);
      for (const check of item.checks) add(check, JSON.stringify(breakCheck(example, check)));
      add(item.invalid_json, "{ not json");
      break;
    }
  }

  // An untagged option only counts as one if grading really produces an untagged wrong answer.
  return options.filter(({ reveals: expected, response }) => {
    const grade = gradeItem(item, response, lessonId);
    return (
      !grade.correct &&
      grade.errors.some((e) => e.points_to === expected.points_to && e.misconception === expected.misconception)
    );
  });
}
