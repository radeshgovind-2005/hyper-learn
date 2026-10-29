import { type Grade, gradeItem } from "../assessment/grade.js";
import type { Course, Lesson, PrereqGraph } from "../course/schema.js";
import type { QuizAttempt } from "../simulation/learners.js";
import type { Gap, NamedMisconception, NodePerformance } from "../state.js";
import { bktMastery, MASTERY_THRESHOLD } from "./bkt.js";
import { type ItemStats, itemStatistics } from "./items.js";

/** A learner passes a quiz with at least this fraction of correct answers. */
export const PASS_THRESHOLD = 0.75;
/** Fewer attempts than this and a fail rate is flagged as unreliable. */
export const MIN_RELIABLE_ATTEMPTS = 30;
const MAX_MISCONCEPTIONS = 3;
const MIN_MISCONCEPTION_SHARE = 0.05;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** 95% Wilson score interval for a proportion; well-behaved for small samples and rates near 0 or 1. */
export function wilsonInterval(hits: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 1];
  const p = hits / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Grades one attempt's scored items (pilot and excluded items are skipped) and whether the attempt passed. */
export function gradeAttempt(
  lesson: Lesson,
  attempt: QuizAttempt,
  excluded: ReadonlySet<string> = new Set(),
): { grades: Grade[]; passed: boolean } {
  const grades = lesson.quiz.flatMap((item, i) => {
    const response = attempt.answers[i];
    if (response === undefined) throw new Error(`Attempt for "${lesson.id}" has no answer to question ${i}`);
    if (item.pilot || excluded.has(item.id)) return [];
    const grade = gradeItem(item, response, lesson.id);
    // A model grade that needs a human's review doesn't count until it gets one.
    return grade.needs_review ? [] : [grade];
  });
  const score = grades.reduce((sum, grade) => sum + grade.score, 0) / Math.max(1, grades.length);
  return { grades, passed: score >= PASS_THRESHOLD };
}

/** Items of a lesson whose statistics show they are broken: they would mislead the diagnosis. */
export function brokenItems(lesson: Lesson, attempts: readonly QuizAttempt[]): ItemStats[] {
  const scored = lesson.quiz.filter((item) => !item.pilot);
  const grades = attempts.map((attempt) => gradeAttempt(lesson, attempt).grades);
  return itemStatistics(
    scored.map((item) => item.id),
    grades,
  ).filter((stats) => stats.flag === "negative_discrimination");
}

/** The named misconceptions a set of attempts show, as a share of the failed attempts. */
function namedMisconceptions(
  course: Course,
  lesson: Lesson,
  attempts: readonly QuizAttempt[],
  excluded: ReadonlySet<string>,
): NamedMisconception[] {
  const shownBy = new Map<string, number>();
  const confident = new Map<string, { sure: number; total: number }>();
  let failed = 0;

  for (const attempt of attempts) {
    const { passed } = gradeAttempt(lesson, attempt, excluded);
    if (passed) continue;
    failed++;
    const shown = new Set<string>();
    lesson.quiz.forEach((item, i) => {
      if (item.pilot || excluded.has(item.id)) return;
      const grade = gradeItem(item, attempt.answers[i]!, lesson.id);
      if (grade.needs_review) return;
      for (const { misconception } of grade.errors) {
        if (!misconception) continue;
        shown.add(misconception);
        const counts = confident.get(misconception) ?? { sure: 0, total: 0 };
        counts.total++;
        if (attempt.certainty[i] === 3) counts.sure++;
        confident.set(misconception, counts);
      }
    });
    for (const id of shown) shownBy.set(id, (shownBy.get(id) ?? 0) + 1);
  }

  return [...shownBy]
    .map(([id, count]) => {
      const { sure, total } = confident.get(id)!;
      return {
        id,
        points_to: course.getMisconception(id)?.lesson ?? lesson.id,
        share: round2(count / failed),
        confident: round2(sure / total),
      };
    })
    .filter((m) => m.share >= MIN_MISCONCEPTION_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_MISCONCEPTIONS);
}

/**
 * Grades quiz attempts and summarises each lesson for the Curator. Lessons nobody took are left out.
 * Items with negative discrimination are excluded first, so a broken question can't drive a diagnosis.
 * Wrong answers are attributed to the lesson they reveal a gap in, or to the lesson itself.
 */
export function computePerformance(
  course: Course,
  published: PrereqGraph,
  attempts: readonly QuizAttempt[],
): NodePerformance[] {
  return course.lessons.flatMap((lesson) => {
    const lessonAttempts = attempts.filter((attempt) => attempt.lesson_id === lesson.id);
    if (lessonAttempts.length === 0) return [];

    const excluded = new Set(brokenItems(lesson, lessonAttempts).map((stats) => stats.item_id));
    let failures = 0;
    let mastered = 0;
    const wrongBy = new Map<string, number>();
    let wrongTotal = 0;

    for (const attempt of lessonAttempts) {
      const { grades, passed } = gradeAttempt(lesson, attempt, excluded);
      for (const { points_to } of grades.flatMap((grade) => grade.errors)) {
        wrongBy.set(points_to, (wrongBy.get(points_to) ?? 0) + 1);
        wrongTotal++;
      }
      if (!passed) failures++;
      if (bktMastery(grades.map((grade) => grade.correct)) >= MASTERY_THRESHOLD) mastered++;
    }

    const gaps: Gap[] = [...wrongBy]
      .map(([points_to, count]) => ({ points_to, share: round2(count / wrongTotal) }))
      .filter((m) => m.share >= MIN_MISCONCEPTION_SHARE)
      .sort((a, b) => b.share - a.share)
      .slice(0, MAX_MISCONCEPTIONS);

    const [low, high] = wilsonInterval(failures, lessonAttempts.length);
    return [
      {
        node_id: lesson.id,
        title: lesson.title,
        attempts: lessonAttempts.length,
        fail_rate: round2(failures / lessonAttempts.length),
        fail_rate_ci: [round2(low), round2(high)],
        low_sample: lessonAttempts.length < MIN_RELIABLE_ATTEMPTS,
        prerequisites: [...(published[lesson.id] ?? [])],
        gaps,
        misconceptions: namedMisconceptions(course, lesson, lessonAttempts, excluded),
        mastery_rate: round2(mastered / lessonAttempts.length),
        excluded_items: [...excluded],
      },
    ];
  });
}
