import { type ItemOf, normalize, passesCheck, type QuizItem, type Response, type WrongAnswerTag } from "./items.js";

/** One wrong answer: which lesson it points to (the item's own lesson = a gap inside it) and the belief, if named. */
export interface WrongAnswer {
  points_to: string;
  misconception?: string;
}

/** The result of grading any item type. Analytics only ever reads this. */
export interface Grade {
  /** 0–1; partial credit where the type allows it. */
  score: number;
  correct: boolean;
  /** Every wrong answer the response contains, tagged where the content names it. */
  errors: WrongAnswer[];
}

const wrong = (lessonId: string, tag: WrongAnswerTag = {}): WrongAnswer => ({
  points_to: tag.reveals_gap_in ?? lessonId,
  ...(tag.misconception && { misconception: tag.misconception }),
});

class InvalidResponse extends Error {}
const fail = (item: QuizItem, why: string): never => {
  throw new InvalidResponse(`Invalid response to "${item.id}" (${item.type}): ${why}`);
};

const isIndex = (value: unknown, length: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;

function indexArray(item: QuizItem, response: Response, length: number): number[] {
  if (!Array.isArray(response) || !response.every((v) => isIndex(v, length))) fail(item, `expected indices below ${length}`);
  return response as number[];
}

function permutation(item: QuizItem, response: Response, length: number): number[] {
  const order = indexArray(item, response, length);
  if (order.length !== length || new Set(order).size !== length) fail(item, `expected a permutation of ${length} indices`);
  return order;
}

/** Length of the longest common subsequence: how much of an order is right. */
function lcs(a: readonly number[], b: readonly number[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[b.length]!;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const done = (score: number, errors: WrongAnswer[]): Grade => ({ score, correct: errors.length === 0, errors });

function gradeSingleChoice(item: ItemOf<"single_choice">, response: Response, lessonId: string): Grade {
  if (!isIndex(response, item.options.length)) fail(item, "expected one option index");
  const option = item.options[response as number]!;
  return option.correct ? done(1, []) : done(0, [wrong(lessonId, option)]);
}

function gradeMultiSelect(item: ItemOf<"multi_select">, response: Response, lessonId: string): Grade {
  const picked = new Set(indexArray(item, response, item.options.length));
  const correctCount = item.options.filter((o) => o.correct).length;
  const errors: WrongAnswer[] = [];
  let hits = 0;
  item.options.forEach((option, i) => {
    if (option.correct && picked.has(i)) hits++;
    else if (option.correct) errors.push(wrong(lessonId)); // missed a correct option
    else if (picked.has(i)) errors.push(wrong(lessonId, option));
  });
  const falsePicks = [...picked].filter((i) => !item.options[i]!.correct).length;
  return done(Math.max(0, (hits - falsePicks) / correctCount), errors);
}

function gradeTwoTier(item: ItemOf<"two_tier">, response: Response, lessonId: string): Grade {
  if (!Array.isArray(response) || response.length !== 2) fail(item, "expected [option, reason]");
  const [a, r] = response as unknown[];
  if (!isIndex(a, item.options.length) || !isIndex(r, item.reasons.length)) fail(item, "option or reason out of range");
  const option = item.options[a as number]!;
  const reason = item.reasons[r as number]!;
  const errors = [option, reason].filter((o) => !o.correct).map((o) => wrong(lessonId, o));
  // Two-tier tests count an answer as right only when the reason is right too.
  return done(errors.length === 0 ? 1 : 0, errors);
}

function gradeOrdering(item: ItemOf<"ordering">, response: Response, lessonId: string): Grade {
  const order = permutation(item, response, item.steps.length);
  const position = new Map(order.map((step, i) => [step, i]));
  const errors = item.patterns
    .filter((p) => position.get(p.first)! < position.get(p.second)!)
    .map((p) => wrong(lessonId, p));
  const solved = order.every((step, i) => step === i);
  if (!solved && errors.length === 0) errors.push(wrong(lessonId));
  return done(lcs(order, range(item.steps.length)) / item.steps.length, errors);
}

function gradeMatching(item: ItemOf<"matching">, response: Response, lessonId: string): Grade {
  const chosen = indexArray(item, response, item.right.length);
  if (chosen.length !== item.left.length) fail(item, `expected one match per term (${item.left.length})`);
  const errors: WrongAnswer[] = [];
  chosen.forEach((right, left) => {
    if (right === left) return;
    errors.push(wrong(lessonId, item.wrong_pairs.find((p) => p.left === left && p.right === right)));
  });
  return done(chosen.filter((right, left) => right === left).length / chosen.length, errors);
}

function gradeCloze(item: ItemOf<"cloze">, response: Response, lessonId: string): Grade {
  if (!Array.isArray(response) || response.length !== item.blanks.length || !response.every((v) => typeof v === "string")) {
    fail(item, `expected ${item.blanks.length} strings`);
  }
  const errors: WrongAnswer[] = [];
  let right = 0;
  item.blanks.forEach((blank, i) => {
    const answer = normalize((response as string[])[i]!);
    if (blank.accept.some((accepted) => normalize(accepted) === answer)) {
      right++;
      return;
    }
    errors.push(wrong(lessonId, blank.wrong.find((w) => new RegExp(w.match, "i").test(answer))));
  });
  return done(right / item.blanks.length, errors);
}

function gradeParsons(item: ItemOf<"parsons">, response: Response, lessonId: string): Grade {
  const ids = indexArray(item, response, item.lines.length + item.distractors.length);
  if (new Set(ids).size !== ids.length) fail(item, "a line was used twice");
  const solution = range(item.lines.length);
  const errors = ids.filter((id) => id >= item.lines.length).map((id) => wrong(lessonId, item.distractors[id - item.lines.length]));
  const solutionOnly = ids.filter((id) => id < item.lines.length);
  const ordered = solutionOnly.length === solution.length && solutionOnly.every((id, i) => id === i);
  if (!ordered && errors.length === 0) errors.push(wrong(lessonId));
  return done(lcs(ids, solution) / Math.max(solution.length, ids.length), errors);
}

function gradeSchemaCompletion(item: ItemOf<"schema_completion">, response: Response, lessonId: string): Grade {
  if (typeof response !== "string") fail(item, "expected JSON text");
  let value: unknown;
  try {
    value = JSON.parse(response as string);
  } catch {
    return done(0, [wrong(lessonId, item.invalid_json)]);
  }
  const failed = item.checks.filter((check) => !passesCheck(value, check));
  return done((item.checks.length - failed.length) / item.checks.length, failed.map((check) => wrong(lessonId, check)));
}

/** Grades one response to one item of lesson `lessonId`. Throws on a malformed response. */
export function gradeItem(item: QuizItem, response: Response, lessonId: string): Grade {
  switch (item.type) {
    case "single_choice":
      return gradeSingleChoice(item, response, lessonId);
    case "multi_select":
      return gradeMultiSelect(item, response, lessonId);
    case "two_tier":
      return gradeTwoTier(item, response, lessonId);
    case "ordering":
      return gradeOrdering(item, response, lessonId);
    case "matching":
      return gradeMatching(item, response, lessonId);
    case "cloze":
      return gradeCloze(item, response, lessonId);
    case "parsons":
      return gradeParsons(item, response, lessonId);
    case "schema_completion":
      return gradeSchemaCompletion(item, response, lessonId);
  }
}
