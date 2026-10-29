import type { Grade } from "../assessment/grade.js";
import type { LiveIntervention } from "../course/compile.js";

// Per-learner adaptation, in code and instant (no model call): what a learner sees next after a quiz.
// The course itself only changes through releases; this only changes one learner's path through it.

export type PathStep =
  | { kind: "continue"; lesson: string }
  | { kind: "intervention"; lesson: string; block_id: string; misconception: string; reason: string }
  | { kind: "review"; lesson: string; reason: string }
  | { kind: "retake"; lesson: string };

/**
 * The steps after one quiz attempt on `lessonId`. A passed quiz continues. A failed one gets, in order:
 * every live intervention aimed at a misconception the learner showed, a review of each other lesson
 * their wrong answers revealed a gap in (when no intervention covers it), and a retake.
 */
export function nextSteps(lessonId: string, grades: readonly Grade[], passed: boolean, live: readonly LiveIntervention[]): PathStep[] {
  if (passed) return [{ kind: "continue", lesson: lessonId }];

  const errors = grades.flatMap((grade) => grade.errors);
  const shown = [...new Set(errors.flatMap((e) => e.misconception ?? []))];
  const steps: PathStep[] = [];
  const covered = new Set<string>();

  for (const misconception of shown) {
    for (const item of live.filter((i) => i.intervention.targets === misconception)) {
      steps.push({
        kind: "intervention",
        lesson: item.lesson,
        block_id: item.block_id,
        misconception,
        reason: `answered as if "${misconception}"`,
      });
      covered.add(item.lesson);
    }
  }

  const gapLessons = [...new Set(errors.map((e) => e.points_to))].filter((id) => id !== lessonId && !covered.has(id));
  for (const lesson of gapLessons) steps.push({ kind: "review", lesson, reason: `wrong answers revealed a gap in ${lesson}` });

  steps.push({ kind: "retake", lesson: lessonId });
  return steps;
}
