import type { Citation, Objective } from "../course/schema.js";
import { citedPage, type Source } from "../course/sources.js";
import type { BuildInput } from "./types.js";
import { fitParts, languageLine, pageLabel, thinLines, uniqueSlug } from "./prompt.js";
import type { PlanDraft } from "./schemas.js";
import type { SourceDigest } from "./sources.js";

// Step 3: the course plan. The planner proposes lessons, sections, pages and objectives by title and
// number; code turns that into ids and refuses a plan it can't build a valid course from.

export interface PlannedSection {
  id: string;
  title: string;
  /** The material pages it is written from; the writer sees only these. */
  pages: Citation[];
}

export interface PlannedLesson {
  id: string;
  title: string;
  summary: string;
  prerequisites: string[];
  sections: PlannedSection[];
  objectives: Objective[];
}

export interface CoursePlan {
  lessons: PlannedLesson[];
}

export interface PlanLimits {
  minLessons: number;
  maxLessons: number;
  minObjectives: number;
  maxObjectives: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = { minLessons: 3, maxLessons: 8, minObjectives: 2, maxObjectives: 5 };

/** The planner's user message: the owner's intent, the material's key ideas by page, and what is evaluated. */
export function plannerPrompt(input: BuildInput, digests: readonly SourceDigest[], limits: PlanLimits, room: number): { prompt: string; dropped: number } {
  const material = digests.filter((d) => d.source.role === "material");
  const evaluated = digests.filter((d) => d.source.role !== "material");
  const header = [
    `Course: ${input.title}`,
    input.description && `Description: ${input.description}`,
    input.goal && `The owner's goal for learners: ${input.goal}`,
    languageLine(input.language),
    `Plan ${limits.minLessons} to ${limits.maxLessons} lessons with ${limits.minObjectives} to ${limits.maxObjectives} objectives each.`,
    `Teaching-material sources you may cite: ${material.map((d) => `${d.source.id} "${d.source.name}" (pages 1-${d.source.pages.length})`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const ideaLines = material.flatMap((d) => d.points.map((p) => `- [${d.source.id} p.${p.pages.join(",")}] ${p.text}`));
  const evaluatedLines = evaluated.flatMap((d) => d.points.map((p) => `- (${d.source.role}: ${d.source.name}) ${p.text}`));
  // Key ideas get most of the room: they are what the plan cites.
  const fixed = header.length + 200;
  const ideas = thinLines(ideaLines, Math.floor((room - fixed) * (evaluatedLines.length > 0 ? 0.75 : 1)));
  const assessed = thinLines(evaluatedLines, room - fixed - ideas.lines.join("\n").length);
  const prompt = fitParts(
    [
      { text: header },
      { text: `Key ideas from the teaching material ([source p.pages] idea):\n${ideas.lines.join("\n")}` },
      { text: `What the assessments and briefs evaluate:\n${assessed.lines.join("\n") || "- (no assessments or briefs were given)"}` },
    ],
    room,
  );
  return { prompt, dropped: ideas.dropped + assessed.dropped };
}

/** Turns a plan draft into a plan with ids, or says why it can't be built. Pages that don't exist are dropped with a warning. */
export function planFromDraft(
  draft: PlanDraft,
  sources: readonly Source[],
  limits: PlanLimits,
): { plan: CoursePlan; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const n = draft.lessons.length;
  if (n < limits.minLessons || n > limits.maxLessons) problems.push(`the plan has ${n} lessons; it needs ${limits.minLessons} to ${limits.maxLessons}`);

  const material = new Set(sources.filter((s) => s.role === "material").map((s) => s.id));
  const lessonIds = new Set<string>();
  const objectiveIds = new Set<string>();
  const ids = draft.lessons.map((lesson, i) => uniqueSlug(lesson.title, `lesson-${i + 1}`, lessonIds));

  const lessons = draft.lessons.map((lesson, i): PlannedLesson => {
    const id = ids[i]!;
    const where = `lesson ${i + 1} ("${lesson.title}")`;
    if (!lesson.title.trim()) problems.push(`${where} has no title`);

    const prerequisites: string[] = [];
    for (const p of lesson.prerequisites) {
      if (!Number.isInteger(p) || p < 1 || p >= i + 1) problems.push(`${where}: prerequisite ${p} is not an earlier lesson (use numbers 1 to ${i})`);
      else if (!prerequisites.includes(ids[p - 1]!)) prerequisites.push(ids[p - 1]!);
    }

    const sectionSlugs = new Set<string>();
    if (lesson.sections.length === 0) problems.push(`${where} has no sections`);
    const sections = lesson.sections.map((section, j): PlannedSection => {
      const pages: Citation[] = [];
      for (const ref of section.pages) {
        const label = pageLabel(ref);
        if (!material.has(ref.source)) warnings.push(`Dropped ${label} from section "${section.title}": not a teaching-material source`);
        else if (citedPage(sources, ref) === undefined) warnings.push(`Dropped ${label} from section "${section.title}": no such page`);
        else if (!pages.some((p) => p.source === ref.source && p.page === ref.page)) pages.push({ source: ref.source, page: ref.page });
      }
      if (pages.length === 0) problems.push(`${where}, section ${j + 1} ("${section.title}") has no teaching-material pages`);
      return { id: `${id}/${uniqueSlug(section.title, `section-${j + 1}`, sectionSlugs)}`, title: section.title.trim() || `Section ${j + 1}`, pages };
    });

    const count = lesson.objectives.length;
    if (count < limits.minObjectives || count > limits.maxObjectives) {
      problems.push(`${where} has ${count} objectives; it needs ${limits.minObjectives} to ${limits.maxObjectives}`);
    }
    const objectives = lesson.objectives.map((objective, k): Objective => {
      const sectionIds: string[] = [];
      for (const s of objective.sections) {
        const section = sections[s - 1];
        if (!section) problems.push(`${where}, objective ${k + 1}: section ${s} does not exist (use 1 to ${sections.length})`);
        else if (!sectionIds.includes(section.id)) sectionIds.push(section.id);
      }
      if (objective.sections.length === 0) problems.push(`${where}, objective ${k + 1} lists no sections that teach it`);
      if (!objective.statement.trim()) problems.push(`${where}, objective ${k + 1} has no statement`);
      return { id: uniqueSlug(`${id}-o${k + 1}`, `${id}-o${k + 1}`, objectiveIds, 60), lesson: id, statement: objective.statement.trim(), sections: sectionIds };
    });
    for (const section of sections) {
      if (!objectives.some((o) => o.sections.includes(section.id))) warnings.push(`Section "${section.id}" teaches no objective`);
    }

    return { id, title: lesson.title.trim(), summary: lesson.summary.trim() || lesson.title.trim(), prerequisites, sections, objectives };
  });

  return { plan: { lessons }, problems, warnings };
}

/** One line per lesson, for the owner's progress view. */
export const describePlan = (plan: CoursePlan) =>
  plan.lessons
    .map((l) => `${l.id}${l.prerequisites.length ? ` (after ${l.prerequisites.join(", ")})` : ""}: ${l.sections.length} sections, ${l.objectives.length} objectives`)
    .join("\n");
