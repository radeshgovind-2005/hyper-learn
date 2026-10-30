import type { ExamConfig, Objective } from "../course/schema.js";
import { seededRandom } from "../simulation/random.js";
import type { QuizItem } from "./items.js";

// Exams drawn from a lesson's question pool, so a retake asks different questions about the same
// objectives. Pure and deterministic for a given seed: the server recomputes a learner's draw when they
// submit instead of storing it.

/** What drawing needs from a lesson; both the Course view (`Lesson`) and a release's `LessonNode` fit. */
export interface ExamLesson {
  id: string;
  quiz: readonly QuizItem[];
  exam?: ExamConfig;
}

/** Most pilot items one exam shows: enough to collect their statistics without crowding the exam. */
export const PILOT_ITEMS_PER_EXAM = 1;

/**
 * The items one attempt shows. Without an `exam` config: the whole quiz, in quiz order (as before).
 * With one: `per_objective` scored items for each of the lesson's objectives, plus one group for items
 * without an objective, plus up to PILOT_ITEMS_PER_EXAM pilot items. Within each group, items the learner
 * hasn't seen come first, then the least recently seen; ties are broken by the seed. The result is
 * shuffled by the seed.
 *
 * `seen` lists the item ids this learner was shown before, oldest first (repeats allowed).
 */
export function drawExam(
  lesson: ExamLesson,
  objectives: readonly Objective[],
  { seen = [], seed }: { seen?: readonly string[]; seed: number },
): QuizItem[] {
  if (!lesson.exam) return [...lesson.quiz];
  const random = seededRandom(seed);
  // One tie-break key per pool item, drawn in quiz order, so the keys don't depend on what was seen.
  const tieBreak = new Map(lesson.quiz.map((item) => [item.id, random()] as const));
  const lastSeen = new Map<string, number>();
  seen.forEach((id, i) => lastSeen.set(id, i));
  const freshest = (items: readonly QuizItem[], n: number) =>
    [...items]
      .sort((a, b) => (lastSeen.get(a.id) ?? -1) - (lastSeen.get(b.id) ?? -1) || tieBreak.get(a.id)! - tieBreak.get(b.id)!)
      .slice(0, n);

  const own = new Set(objectives.filter((o) => o.lesson === lesson.id).map((o) => o.id));
  const scored = lesson.quiz.filter((item) => !item.pilot);
  const groups = [
    ...[...own].map((id) => scored.filter((item) => item.objective === id)),
    scored.filter((item) => item.objective === undefined || !own.has(item.objective)),
  ];
  const drawn = [
    ...groups.flatMap((group) => freshest(group, lesson.exam!.per_objective)),
    ...freshest(
      lesson.quiz.filter((item) => item.pilot),
      PILOT_ITEMS_PER_EXAM,
    ),
  ];

  // Fisher–Yates, so the order says nothing about which objective an item tests.
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!];
  }
  return drawn;
}

/** A 32-bit seed from any parts, e.g. (learner, lesson, attempt number, release version). FNV-1a, then mixed. */
export function examSeed(...parts: readonly (string | number)[]): number {
  let h = 2166136261;
  for (const c of parts.join("\u0000")) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
