import type { Grade } from "../assessment/grade.js";
import type { LiveIntervention } from "../course/compile.js";
import type { Objective } from "../course/schema.js";

// Per-learner adaptation, in code and instant (no model call): what a learner sees next after a quiz.
// The course itself only changes through releases; this only changes one learner's path through it.

export type PathStep =
  | { kind: "continue"; lesson: string }
  | { kind: "intervention"; lesson: string; block_id: string; misconception: string; reason: string }
  | { kind: "review_section"; lesson: string; section_id: string; objective: string; reason: string }
  | { kind: "review"; lesson: string; reason: string }
  | { kind: "retake"; lesson: string };

/**
 * The steps after one quiz attempt on `lessonId`. A passed quiz continues. A failed one gets, in order:
 * every live intervention aimed at a misconception the learner showed, the first section of each
 * objective they answered wrongly (from `objectives`, in course order; once per section), a review of
 * each other lesson their wrong answers revealed a gap in (when no intervention covers it), and a retake.
 * Pass the release's live objectives (liveObjectives), so archived sections aren't suggested.
 */
export function nextSteps(
  lessonId: string,
  grades: readonly Grade[],
  passed: boolean,
  live: readonly LiveIntervention[],
  objectives: readonly Objective[] = [],
): PathStep[] {
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

  const missed = new Set(grades.flatMap((grade) => (!grade.correct && grade.objective ? [grade.objective] : [])));
  const sections = new Set<string>();
  for (const objective of objectives) {
    const section_id = objective.sections[0];
    if (!missed.has(objective.id) || !section_id || sections.has(section_id)) continue;
    sections.add(section_id);
    steps.push({ kind: "review_section", lesson: objective.lesson, section_id, objective: objective.id, reason: `missed "${objective.statement}"` });
  }

  const gapLessons = [...new Set(errors.map((e) => e.points_to))].filter((id) => id !== lessonId && !covered.has(id));
  for (const lesson of gapLessons) steps.push({ kind: "review", lesson, reason: `wrong answers revealed a gap in ${lesson}` });

  steps.push({ kind: "retake", lesson: lessonId });
  return steps;
}
