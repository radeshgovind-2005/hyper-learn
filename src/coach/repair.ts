import type { QuizItem } from "../assessment/items.js";
import { type CourseSnapshot, isTextBlock } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import type { Source } from "../course/sources.js";
import { plannedLessons } from "../edit/run.js";
import { retryText } from "../generate/build.js";
import { CallBudgetExceeded, type BuilderModels, ModelCalls } from "../generate/models.js";
import type { PlannedSection } from "../generate/plan.js";
import { factCheckPrompt } from "../generate/review.js";
import type { SectionDraft } from "../generate/schemas.js";
import type { BuildInput } from "../generate/types.js";
import { sectionFromDraft, type WrittenSection, writerPrompt } from "../generate/write.js";
import type { DiagnosisResult, Target } from "./diagnose.js";

// The study coach, part two: a lesson written for one learner and one target, from the pages of the
// course that teach it, by the build's writer and checked like the build's sections (citations, then a
// fact check). A misconception gets a refutation text (name the belief, say why it seems right, show
// why it's wrong): the approach with the most evidence behind it. If the learner still misses the
// re-check, the next try changes approach rather than repeating itself.

export const APPROACHES = ["refute", "worked_example", "smaller_steps"] as const;
export type Approach = (typeof APPROACHES)[number];

/** The approach for a target's n-th try (0-based): misconceptions start with a refutation. */
export function approachFor(target: Target, attempt: number): Approach {
  const order: Approach[] = target.kind === "misconception" ? ["refute", "worked_example", "smaller_steps"] : ["worked_example", "smaller_steps", "refute"];
  return order[attempt % order.length]!;
}

const HOW: Record<Approach, string> = {
  refute:
    "Write it as a refutation text: start by stating the mistaken idea the way the learner would hold it, say briefly why it seems right, then show with an example from the pages why it is wrong, and state what is true.",
  worked_example: "Teach it through one worked example from the pages, step by step, saying why each step is taken; then state the general idea in one sentence.",
  smaller_steps: "Teach it in small numbered steps, one idea per step, defining each term the first time it appears. Short sentences.",
};

export interface RepairInput {
  course: Pick<BuildInput, "course_id" | "title" | "language">;
  snapshot: CourseSnapshot;
  sources: readonly Source[];
  target: Target;
  approach: Approach;
  /** The learner's own words about what confuses them, if they gave any. */
  note?: string;
  /** Their wrong answers on this target, from the diagnostic or the last re-check. */
  wrong: DiagnosisResult["wrong"];
}

export interface PersonalSection {
  title: string;
  /** Text blocks (Markdown with the pages they cite) and one practice question. */
  section: WrittenSection;
  /** Doubts the fact check kept, if any. */
  doubts: string[];
}

export type RepairResult = { ok: true; repair: PersonalSection; model_calls: number } | { ok: false; problems: string[]; model_calls: number };

/** The sections that teach a target: an objective's sections, a misconception's tagged items' objectives, or a lesson's first ones. */
export function sectionsFor(snapshot: CourseSnapshot, target: Target): string[] {
  const objectives = snapshot.objectives ?? [];
  const lesson = snapshot.lessons.find((l) => l.id === target.lesson);
  const sectionsOf = (objectiveIds: readonly string[]) => [...new Set(objectives.filter((o) => objectiveIds.includes(o.id)).flatMap((o) => o.sections))];
  let ids: string[] = [];
  if (target.kind === "objective") ids = sectionsOf([target.id]);
  else if (target.kind === "gap" && target.objective) ids = sectionsOf([target.objective]);
  else if (target.kind === "misconception" && lesson) {
    const tagged = lesson.quiz.filter((q) => JSON.stringify(q).includes(`"misconception":"${target.id}"`)).flatMap((q) => (q.objective ? [q.objective] : []));
    ids = sectionsOf(tagged);
  }
  const live = lesson?.sections.filter((s) => !s.archived).map((s) => s.id) ?? [];
  const chosen = ids.filter((id) => live.includes(id));
  return chosen.length > 0 ? chosen.slice(0, 2) : live.slice(0, 2);
}

/** The pages the target's sections cite, at most `max`. */
function pagesFor(snapshot: CourseSnapshot, sectionIds: readonly string[], max = 4): Citation[] {
  const pages: Citation[] = [];
  for (const lesson of snapshot.lessons) {
    for (const section of lesson.sections) {
      if (!sectionIds.includes(section.id)) continue;
      for (const b of section.blocks) {
        if (b.archived || !isTextBlock(b)) continue;
        for (const c of b.cites ?? []) if (!pages.some((p) => p.source === c.source && p.page === c.page)) pages.push({ ...c });
      }
    }
  }
  return pages.slice(0, max);
}

function describe(snapshot: CourseSnapshot, target: Target): { title: string; what: string } {
  const objective = (id?: string) => (snapshot.objectives ?? []).find((o) => o.id === id)?.statement;
  const lessonTitle = snapshot.lessons.find((l) => l.id === target.lesson)?.title ?? target.lesson;
  switch (target.kind) {
    case "misconception": {
      const belief = snapshot.misconceptions.find((m) => m.id === target.id)?.belief ?? target.id;
      return { title: "Untangling a common mix-up", what: `The learner believes: "${belief}". Help them see why that's wrong and what is true.` };
    }
    case "objective":
      return { title: objective(target.id) ?? lessonTitle, what: `The learner can't yet: ${objective(target.id) ?? lessonTitle}.` };
    case "gap":
      return {
        title: `Back to basics: ${objective(target.objective) ?? lessonTitle}`,
        what: `The learner is missing an idea from the earlier lesson "${lessonTitle}"${target.objective ? `: ${objective(target.objective)}` : ""}. Re-teach it briefly so the later lessons make sense.`,
      };
    case "ready":
      return { title: lessonTitle, what: "Nothing to repair." };
  }
}

export async function writeRepair(input: RepairInput, models: Pick<BuilderModels, "writer" | "fact_checker">, maxCalls = 6): Promise<RepairResult> {
  const calls = new ModelCalls(24_000, maxCalls);
  const { snapshot, target } = input;
  try {
    if (target.kind === "ready") return { ok: false, problems: ["Nothing to repair: you're ready for the exam"], model_calls: 0 };
    const lessons = plannedLessons(snapshot);
    const lesson = lessons.find((l) => l.id === target.lesson);
    if (!lesson) return { ok: false, problems: [`No lesson "${target.lesson}"`], model_calls: 0 };
    const pages = pagesFor(snapshot, sectionsFor(snapshot, target));
    if (pages.length === 0) return { ok: false, problems: ["This part of the course cites no pages to write from"], model_calls: 0 };
    const { title, what } = describe(snapshot, target);
    const section: PlannedSection = { id: `${lesson.id}/for-you`, title, pages };
    const wrong = input.wrong.slice(0, 3).map((w) => `- Question: ${w.prompt}${w.chose ? `\n  They chose: ${w.chose}` : ""}`);
    const request = [
      "WRITE A SHORT PERSONAL LESSON FOR ONE LEARNER WHO IS STUCK (3 or 4 blocks, under 250 words in all).",
      what,
      HOW[input.approach],
      input.note?.trim() && `In their own words, what confuses them: "${input.note.trim().slice(0, 500)}"`,
      wrong.length > 0 && `Their wrong answers:\n${wrong.join("\n")}`,
      "Speak to them as \"you\". End with a practice question that checks exactly this point; if there is a mistaken idea, make it one of the wrong options.",
    ]
      .filter(Boolean)
      .join("\n");
    const course: BuildInput = { ...input.course, sources: [...input.sources] };

    let draft: SectionDraft | undefined;
    let written: WrittenSection | undefined;
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2 && !written; attempt++) {
      const room = calls.room("writer");
      const fix = attempt > 0 ? retryText("writer", "fix", draft, problems, room) : "";
      draft = await calls.invoke(models.writer, "writer", writerPrompt({ input: course, sources: input.sources, lesson, section }, room, [request, fix].filter(Boolean).join("\n\n")));
      const result = sectionFromDraft(draft, section);
      if (result.section) written = result.section;
      else problems = result.problems;
    }
    if (!written) return { ok: false, problems, model_calls: calls.count };

    // Fact check; one rewrite of what it doubts, then keep what we have and say so.
    let doubts: string[] = [];
    try {
      const verdict = await calls.invoke(models.fact_checker, "fact_checker", factCheckPrompt(input.sources, lesson, section, written, calls.room("fact_checker")));
      if (!verdict.supported) {
        doubts = verdict.unsupported.length > 0 ? verdict.unsupported : ["(the fact checker named no claim)"];
        const room = calls.room("writer");
        const revised = sectionFromDraft(await calls.invoke(models.writer, "writer", writerPrompt({ input: course, sources: input.sources, lesson, section }, room, retryText("writer", "revise", draft, doubts, room))), section);
        if (revised.section) {
          written = revised.section;
          const again = await calls.invoke(models.fact_checker, "fact_checker", factCheckPrompt(input.sources, lesson, section, written, calls.room("fact_checker")));
          doubts = again.supported ? [] : again.unsupported;
        }
      }
    } catch (error) {
      if (error instanceof CallBudgetExceeded) throw error;
      doubts = ["It couldn't be fact-checked just now"];
    }
    return { ok: true, repair: { title, section: written, doubts }, model_calls: calls.count };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)], model_calls: calls.count };
  }
}

/** Questions that check a target, the learner hasn't seen, at most `n`: the re-check after a repair. */
export function recheckItems(snapshot: CourseSnapshot, target: Target, seen: ReadonlySet<string>, n = 2): { lesson: string; item: QuizItem }[] {
  const lesson = snapshot.lessons.find((l) => l.id === target.lesson);
  if (!lesson) return [];
  const pool = lesson.quiz.filter((q) => !q.pilot);
  const fits = (q: QuizItem) => {
    if (target.kind === "objective") return q.objective === target.id;
    if (target.kind === "gap") return target.objective ? q.objective === target.objective : true;
    if (target.kind === "misconception") return JSON.stringify(q).includes(`"misconception":"${target.id}"`);
    return false;
  };
  const candidates = pool.filter(fits);
  const ordered = [...candidates.filter((q) => !seen.has(q.id)), ...candidates.filter((q) => seen.has(q.id))];
  return ordered.slice(0, n).map((item) => ({ lesson: lesson.id, item }));
}
