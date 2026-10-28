import type { Course, PrereqGraph } from "../course/schema.js";
import type { QuizAttempt } from "../simulation/learners.js";
import type { Misconception, NodePerformance } from "../state.js";

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
 * Grades quiz attempts and summarises each lesson for the Curator. Lessons nobody took are left out.
 * Wrong answers are attributed to the lesson their option reveals a gap in, or to the lesson itself.
 */
export function computePerformance(
  course: Course,
  published: PrereqGraph,
  attempts: readonly QuizAttempt[],
): NodePerformance[] {
  return course.lessons.flatMap((lesson) => {
    const lessonAttempts = attempts.filter((attempt) => attempt.lesson_id === lesson.id);
    if (lessonAttempts.length === 0) return [];

    let failures = 0;
    const wrongBy = new Map<string, number>();
    let wrongTotal = 0;

    for (const attempt of lessonAttempts) {
      let correct = 0;
      attempt.answers.forEach((choice, i) => {
        const option = lesson.quiz[i]?.options[choice];
        if (!option) throw new Error(`Attempt for "${lesson.id}" has an invalid answer at question ${i}`);
        if (option.correct) {
          correct++;
          return;
        }
        const pointsTo = option.reveals_gap_in ?? lesson.id;
        wrongBy.set(pointsTo, (wrongBy.get(pointsTo) ?? 0) + 1);
        wrongTotal++;
      });
      if (correct / lesson.quiz.length < PASS_THRESHOLD) failures++;
    }

    const misconceptions: Misconception[] = [...wrongBy]
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
        misconceptions,
      },
    ];
  });
}
