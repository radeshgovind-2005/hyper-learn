import type { QuizItem } from "../assessment/items.js";
import { type CourseSnapshot, isTextBlock } from "../course/compile.js";
import { citedPage, type Source } from "../course/sources.js";
import { contentWords, overlap, PROMPT_OVERLAP_LIMIT } from "../interventions/checks.js";
import { pageLabel } from "./prompt.js";
import { GENERATED_ITEM_TYPES } from "./schemas.js";

// Code checks on a generated snapshot, on top of courseFromSnapshot. They mirror the objective, exam
// and check-block rules of the assessment workstream (docs/studio/PLAN.md, A item 3) so a generated
// course satisfies them before they land in the shared validator, and add generation's own rules:
// only the item types we generate, every text block grounded in a real material page, and nothing
// copied from an assessment.

/** A sentence shorter than this (in content words) is too generic to count as copied ("Define a cache."). */
export const MIN_COPY_WORDS = 6;

export interface AssessmentSentence {
  source: string;
  page: number;
  text: string;
}

/** A source's sentences long enough to be recognisably copied. */
export const sentencesOf = (source: Source): AssessmentSentence[] =>
  source.pages.flatMap((text, i) =>
    text
      .split(/(?<=[.?!])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => contentWords(sentence).size >= MIN_COPY_WORDS)
      .map((sentence) => ({ source: source.id, page: i + 1, text: sentence })),
  );

/** The sentences of the assessment sources long enough to be recognisably copied. */
export const assessmentSentences = (sources: readonly Source[]): AssessmentSentence[] =>
  sources.filter((s) => s.role === "assessment").flatMap(sentencesOf);

/** The assessment sentence `text` copies (shares at least PROMPT_OVERLAP_LIMIT of the vocabulary with), if any. */
export function copiedSentence(text: string, sentences: readonly AssessmentSentence[]): AssessmentSentence | undefined {
  return sentences.find((s) => overlap(text, s.text) >= PROMPT_OVERLAP_LIMIT);
}

/** The question texts of an item that must not come from an assessment. */
export const itemPrompts = (item: QuizItem): string[] => (item.type === "two_tier" ? [item.prompt, item.reason_prompt] : [item.prompt]);

export interface StudioProblem {
  lesson?: string;
  section?: string;
  message: string;
}

export function studioChecks(snapshot: CourseSnapshot, sources: readonly Source[]): StudioProblem[] {
  const problems: StudioProblem[] = [];
  const lessons = snapshot.lessons.filter((l) => !l.archived);
  const objectives = snapshot.objectives ?? [];
  const objectiveById = new Map(objectives.map((o) => [o.id, o]));
  const catalog = new Set(snapshot.misconceptions.map((m) => m.id));
  const sentences = assessmentSentences(sources);

  const seen = new Set<string>();
  for (const objective of objectives) {
    if (seen.has(objective.id)) problems.push({ message: `Duplicate objective id "${objective.id}"` });
    seen.add(objective.id);
    const lesson = lessons.find((l) => l.id === objective.lesson);
    if (!lesson) {
      problems.push({ message: `Objective "${objective.id}" belongs to unknown lesson "${objective.lesson}"` });
      continue;
    }
    for (const id of objective.sections) {
      if (!lesson.sections.some((s) => s.id === id && !s.archived)) {
        problems.push({ lesson: lesson.id, message: `Objective "${objective.id}" lists "${id}", which is not a section of "${lesson.id}"` });
      }
    }
  }

  for (const lesson of lessons) {
    const own = objectives.filter((o) => o.lesson === lesson.id);
    const scored = lesson.quiz.filter((item) => !item.pilot);
    if (own.length > 0) {
      for (const item of scored) {
        if (!item.objective || !own.some((o) => o.id === item.objective)) {
          problems.push({ lesson: lesson.id, message: `Question "${item.id}" in "${lesson.id}" names no objective of its lesson` });
        }
      }
      const perObjective = lesson.exam?.per_objective ?? 1;
      for (const objective of own) {
        const count = scored.filter((item) => item.objective === objective.id).length;
        if (count < 2 * perObjective) {
          problems.push({
            lesson: lesson.id,
            message: `Objective "${objective.id}" has ${count} scored questions; it needs at least ${2 * perObjective} so a retake can be fresh`,
          });
        }
      }
    }

    for (const item of lesson.quiz) {
      if (!(GENERATED_ITEM_TYPES as readonly string[]).includes(item.type)) {
        problems.push({ lesson: lesson.id, message: `Question "${item.id}" in "${lesson.id}" is a ${item.type}; generated pools use ${GENERATED_ITEM_TYPES.join(", ")}` });
      }
      for (const prompt of itemPrompts(item)) {
        const copied = copiedSentence(prompt, sentences);
        if (copied) {
          problems.push({ lesson: lesson.id, message: `Question "${item.id}" in "${lesson.id}" copies an assessment question (${pageLabel(copied)}): "${copied.text.slice(0, 80)}"` });
        }
      }
    }

    for (const section of lesson.sections.filter((s) => !s.archived)) {
      const at = { lesson: lesson.id, section: section.id };
      for (const block of section.blocks.filter((b) => !b.archived)) {
        if (block.kind === "check") {
          const correct = block.check.options.filter((o) => o.correct);
          if (correct.length !== 1) problems.push({ ...at, message: `Check "${block.id}" must have exactly one correct option (has ${correct.length})` });
          if (correct.some((o) => o.misconception !== null)) problems.push({ ...at, message: `Check "${block.id}": the correct option can't express a misconception` });
          for (const o of block.check.options) {
            if (o.misconception !== null && !catalog.has(o.misconception)) problems.push({ ...at, message: `Check "${block.id}": unknown misconception "${o.misconception}"` });
          }
          if (block.objective !== undefined && objectiveById.get(block.objective)?.lesson !== lesson.id) {
            problems.push({ ...at, message: `Check "${block.id}" practises "${block.objective}", which is not an objective of "${lesson.id}"` });
          }
        } else if (isTextBlock(block)) {
          if (!block.cites || block.cites.length === 0) problems.push({ ...at, message: `Block "${block.id}" cites no source page` });
          for (const cite of block.cites ?? []) {
            const source = sources.find((s) => s.id === cite.source);
            if (citedPage(sources, cite) === undefined) problems.push({ ...at, message: `Block "${block.id}" cites ${pageLabel(cite)}, which doesn't exist` });
            else if (source?.role !== "material") problems.push({ ...at, message: `Block "${block.id}" cites ${pageLabel(cite)}, which is ${source?.role ?? "unclassified"}, not teaching material` });
          }
        }
      }
    }
  }
  return problems;
}
