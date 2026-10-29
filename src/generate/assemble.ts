import { type Block, type CourseSnapshot, KIND_PREFIX, type TextKind } from "../course/compile.js";
import type { LessonAssessment } from "./assess.js";
import type { CoursePlan } from "./plan.js";
import type { WrittenSection } from "./write.js";

// Step 6, first half: the snapshot is put together in code from the plan and the checked drafts.
// Block ids follow the compiler's scheme (`<section>/<p|l|c|k><n>`), so releases treat generated
// content like compiled content.

export const GENERATED_VERSION = "1.0.0";

export function assembleSnapshot(
  course: { id: string; title: string },
  plan: CoursePlan,
  sections: ReadonlyMap<string, WrittenSection>,
  assessments: ReadonlyMap<string, LessonAssessment>,
  perObjective: number,
): CourseSnapshot {
  return {
    course_id: course.id,
    title: course.title,
    version: GENERATED_VERSION,
    lessons: plan.lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      prerequisites: [...lesson.prerequisites],
      archived: false,
      exam: { per_objective: perObjective },
      quiz: assessments.get(lesson.id)?.items ?? [],
      sections: lesson.sections.map((planned) => {
        const written = sections.get(planned.id);
        const counters: Record<TextKind, number> = { paragraph: 0, list: 0, code: 0 };
        const blocks: Block[] = (written?.blocks ?? []).map((b) => ({
          id: `${planned.id}/${KIND_PREFIX[b.kind]}${++counters[b.kind]}`,
          kind: b.kind,
          markdown: b.markdown,
          cites: b.cites.map((c) => ({ ...c })),
          archived: false,
        }));
        // The check practises the first objective this section teaches.
        const objective = lesson.objectives.find((o) => o.sections.includes(planned.id));
        if (written) {
          blocks.push({ id: `${planned.id}/${KIND_PREFIX.check}1`, kind: "check", check: written.check, archived: false, ...(objective && { objective: objective.id }) });
        }
        return { id: planned.id, title: planned.title, blocks, archived: false };
      }),
    })),
    misconceptions: plan.lessons.flatMap((lesson) => assessments.get(lesson.id)?.misconceptions ?? []),
    objectives: plan.lessons.flatMap((lesson) => lesson.objectives.map((o) => ({ ...o, sections: [...o.sections] }))),
  };
}
