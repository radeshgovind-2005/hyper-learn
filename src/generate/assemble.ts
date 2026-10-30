import { type Block, type CourseSnapshot, KIND_PREFIX, type TextKind } from "../course/compile.js";
import type { QuizItem } from "../assessment/items.js";
import { examSeed } from "../assessment/exam.js";
import { seededRandom } from "../simulation/random.js";
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

/** Fisher–Yates with a seed, so the same course always shows the same order. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Shuffles every option list, seeded by course and item id. Models put the right answer first almost
 * every time (44 of 46 single-choice questions in the first real build), and options are shown in the
 * stored order, so a learner could pass by always picking the first. Ordering steps stay as they are:
 * they are stored in the correct order and shuffled when shown. Runs after validation, because fix
 * rounds refer to options by their drafted number.
 */
export function shuffleOptions(snapshot: CourseSnapshot): CourseSnapshot {
  return {
    ...snapshot,
    lessons: snapshot.lessons.map((lesson) => ({
      ...lesson,
      quiz: lesson.quiz.map((q) => shuffleItem(snapshot.course_id, q)),
      sections: lesson.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((b) => (b.kind === "check" ? shuffleCheck(snapshot.course_id, b) : b)),
      })),
    })),
  };
}

/** One question's options shuffled, seeded by course and item id (owner edits add questions one by one). */
export function shuffleItem(courseId: string, q: QuizItem): QuizItem {
  const seed = (part: string) => examSeed(courseId, q.id, part);
  switch (q.type) {
    case "single_choice":
    case "multi_select":
      return { ...q, options: shuffled(q.options, seed("options")) };
    case "two_tier":
      return { ...q, options: shuffled(q.options, seed("options")), reasons: shuffled(q.reasons, seed("reasons")) };
    default:
      return q;
  }
}

export function shuffleCheck<B extends { id: string; check: { options: readonly unknown[] } }>(courseId: string, block: B): B {
  return { ...block, check: { ...block.check, options: shuffled(block.check.options, examSeed(courseId, block.id, "options")) } };
}
