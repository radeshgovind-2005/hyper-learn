import type { CourseSnapshot } from "../course/compile.js";
import type { QuizItem, Response } from "./items.js";

// What a learner's browser may know about a question: what it asks and what can be picked, never which
// answer is right. Grading and feedback happen on the server (gradeItem, answerCheck), so the key never
// needs to leave it. Removing the key isn't enough where the order *is* the answer (ordering steps,
// matching pairs, Parsons lines), so those are also shuffled by a secret per-course salt, and a learner's
// response comes back in that shuffled order and is mapped to the authored one before grading.

/** A permutation of 0…n-1 from a seed (FNV-1a, then mulberry32): the same seed always gives the same order. */
export function permutation(n: number, seed: string): number[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const random = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), h | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Shown position → authored index, for the part of an item whose order is the answer (empty if none). */
function orderOf(item: QuizItem, salt: string): number[] {
  const seed = `${salt}:${item.id}`;
  switch (item.type) {
    case "ordering":
      return permutation(item.steps.length, seed);
    case "matching":
      return permutation(item.right.length, seed);
    case "parsons":
      return permutation(item.lines.length + item.distractors.length, seed);
    default:
      return [];
  }
}

const option = (o: { text: string }) => ({ text: o.text });

/**
 * The question as a learner's browser gets it. The result is shaped like a QuizItem so the UI renders it
 * as before, but the fields that carry the key (`correct`, tags, accepted answers, rubrics, examples) are
 * gone, and ordered parts are in the salted order. Parsons lines and distractors are one shuffled pool.
 */
export function learnerItem(item: QuizItem, salt: string): QuizItem {
  const base = { id: item.id, prompt: item.prompt, pilot: item.pilot, ...(item.objective && { objective: item.objective }) };
  const order = orderOf(item, salt);
  let view: unknown;
  switch (item.type) {
    case "single_choice":
    case "multi_select":
      view = { type: item.type, ...base, options: item.options.map(option) };
      break;
    case "two_tier":
      view = { type: item.type, ...base, options: item.options.map(option), reason_prompt: item.reason_prompt, reasons: item.reasons.map(option) };
      break;
    case "ordering":
      view = { type: item.type, ...base, steps: order.map((i) => item.steps[i]!), patterns: [] };
      break;
    case "matching":
      view = { type: item.type, ...base, left: item.left, right: order.map((i) => item.right[i]!), wrong_pairs: [] };
      break;
    case "cloze":
      view = { type: item.type, ...base, text: item.text, blanks: item.blanks.map(() => ({ accept: [], wrong: [] })) };
      break;
    case "parsons": {
      const pool = [...item.lines, ...item.distractors.map((d) => d.text)];
      view = { type: item.type, ...base, lines: order.map((i) => pool[i]!), distractors: [] };
      break;
    }
    case "schema_completion":
      view = { type: item.type, ...base, example: "", checks: [], invalid_json: {} };
      break;
    case "short_answer":
      view = { type: item.type, ...base, reference_answer: "", rubric: [], detectors: [], calibration: [] };
      break;
  }
  return view as QuizItem;
}

/** A response given on learnerItem's view, mapped back to the authored order the graders expect. */
export function fromLearnerResponse(item: QuizItem, response: Response, salt: string): Response {
  const order = orderOf(item, salt);
  if (order.length === 0 || !Array.isArray(response)) return response;
  // Out-of-range picks (-1 for "not matched yet", or junk) stay as they are; the grader rejects or scores them.
  return (response as unknown[]).map((v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < order.length ? order[v]! : v)) as Response;
}

/**
 * A release as a learner's browser gets it: every quiz item through learnerItem, and practice checks
 * without which option is right or its feedback (answerCheck returns both once the learner picks).
 */
export function learnerSnapshot(snapshot: CourseSnapshot, salt: string): CourseSnapshot {
  return {
    ...snapshot,
    lessons: snapshot.lessons.map((lesson) => ({
      ...lesson,
      quiz: lesson.quiz.map((item) => learnerItem(item, salt)),
      sections: lesson.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) =>
          block.kind === "check" ? ({ ...block, check: { prompt: block.check.prompt, options: block.check.options.map(option) } } as typeof block) : block,
        ),
      })),
    })),
  };
}
