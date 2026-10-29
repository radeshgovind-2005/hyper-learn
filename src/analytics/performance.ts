import { type Grade, gradeItem } from "../assessment/grade.js";
import type { QuizItem } from "../assessment/items.js";
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

/**
 * The items an attempt showed, in the order of its answers: `item_ids` when the exam was drawn from a
 * pool, else the whole quiz in order (attempts recorded before exams were drawn have no `item_ids`).
 */
export function attemptItems(lesson: Lesson, attempt: QuizAttempt): QuizItem[] {
  if (!attempt.item_ids) return lesson.quiz;
  if (attempt.item_ids.length !== attempt.answers.length) {
    throw new Error(`Attempt for "${lesson.id}" shows ${attempt.item_ids.length} items but has ${attempt.answers.length} answers`);
  }
  if (new Set(attempt.item_ids).size !== attempt.item_ids.length) throw new Error(`Attempt for "${lesson.id}" shows an item twice`);
  return attempt.item_ids.map((id) => {
    const item = lesson.quiz.find((q) => q.id === id);
    if (!item) throw new Error(`Attempt for "${lesson.id}" answers "${id}", which is not in its quiz`);
    return item;
  });
}

/** One scored answer: the item, its grade, and where it sat in the attempt (to read its certainty). */
export interface ScoredAnswer {
  item: QuizItem;
  position: number;
  grade: Grade;
}

/**
 * Grades one attempt's scored items (pilot and excluded items are skipped) and whether the attempt passed.
 * `scored` keys each grade by its item, since a drawn exam shows only some of the pool.
 * Passing needs the mean score, and for items with objectives at least one fully right answer per
 * objective shown: partial credit alone (half a multi-select, most of an ordering) isn't mastery of one.
 */
export function gradeAttempt(
  lesson: Lesson,
  attempt: QuizAttempt,
  excluded: ReadonlySet<string> = new Set(),
): { grades: Grade[]; passed: boolean; scored: ScoredAnswer[] } {
  const scored = attemptItems(lesson, attempt).flatMap((item, i): ScoredAnswer[] => {
    const response = attempt.answers[i];
    if (response === undefined) throw new Error(`Attempt for "${lesson.id}" has no answer to question ${i}`);
    if (item.pilot || excluded.has(item.id)) return [];
    const grade = gradeItem(item, response, lesson.id);
    // A model grade that needs a human's review doesn't count until it gets one.
    return grade.needs_review ? [] : [{ item, position: i, grade }];
  });
  const grades = scored.map((s) => s.grade);
  const score = grades.reduce((sum, grade) => sum + grade.score, 0) / Math.max(1, grades.length);
  const objectives = new Set(scored.flatMap((s) => (s.item.objective ? [s.item.objective] : [])));
  const everyObjective = [...objectives].every((o) => scored.some((s) => s.item.objective === o && s.grade.correct));
  return { grades, passed: score >= PASS_THRESHOLD && everyObjective, scored };
}

/**
 * Items of a lesson whose statistics show they are broken: they would mislead the diagnosis.
 * Each item is judged only on the attempts that showed it.
 */
export function brokenItems(lesson: Lesson, attempts: readonly QuizAttempt[]): ItemStats[] {
  const scored = lesson.quiz.filter((item) => !item.pilot).map((item) => item.id);
  const grades = attempts.map((attempt) => {
    const byItem = new Map(gradeAttempt(lesson, attempt).scored.map((s) => [s.item.id, s.grade] as const));
    return scored.map((id) => byItem.get(id));
  });
  return itemStatistics(scored, grades).filter((stats) => stats.flag === "negative_discrimination");
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
    const { passed, scored } = gradeAttempt(lesson, attempt, excluded);
    if (passed) continue;
    failed++;
    const shown = new Set<string>();
    for (const { grade, position } of scored) {
      for (const { misconception } of grade.errors) {
        if (!misconception) continue;
        shown.add(misconception);
        const counts = confident.get(misconception) ?? { sure: 0, total: 0 };
        counts.total++;
        if (attempt.certainty[position] === 3) counts.sure++;
        confident.set(misconception, counts);
      }
    }
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
        // Whether a live intervention targets it depends on the release, not the answers: set by releasePerformance().
        covered: false,
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
 * Lessons with objectives also get each objective's miss rate (over the attempts that showed its items).
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

    const own = course.objectives.filter((o) => o.lesson === lesson.id);
    const byObjective = new Map(own.map((o): [string, { responses: number; wrong: number }] => [o.id, { responses: 0, wrong: 0 }]));

    for (const attempt of lessonAttempts) {
      const { grades, passed } = gradeAttempt(lesson, attempt, excluded);
      for (const grade of grades) {
        const counts = grade.objective === undefined ? undefined : byObjective.get(grade.objective);
        if (!counts) continue;
        counts.responses++;
        if (!grade.correct) counts.wrong++;
      }
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
        ...(own.length > 0 && {
          objectives: [...byObjective]
            .filter(([, c]) => c.responses > 0)
            .map(([id, c]) => ({ id, miss_rate: round2(c.wrong / c.responses), responses: c.responses })),
        }),
      },
    ];
  });
}
