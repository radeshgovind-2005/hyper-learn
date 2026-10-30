import type { QuizItem } from "../assessment/items.js";
import { type CourseSnapshot, isTextBlock } from "../course/compile.js";
import { citedPage, type Source } from "../course/sources.js";
import { contentWords, overlap, PROMPT_OVERLAP_LIMIT } from "../interventions/checks.js";
import { pageLabel } from "./prompt.js";
import { GENERATED_ITEM_TYPES } from "./schemas.js";

// Generation's own code checks on a snapshot, on top of courseFromSnapshot (which checks objectives,
// exam pools and check blocks for every course): only the item types we generate, every text block
// grounded in a real material page, and nothing copied from an assessment.

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
  const sentences = assessmentSentences(sources);

  for (const lesson of lessons) {
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
        if (isTextBlock(block)) {
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

/**
 * Splits a courseFromSnapshot error into its problems and routes each by the first quoted id it names:
 * a section or block goes to that section (its writer); a lesson, question, misconception or objective
 * to that lesson (its examiner). Problems that name none stay unrouted.
 */
export function routeValidationError(snapshot: CourseSnapshot, error: string): StudioProblem[] {
  const owner = new Map<string, Omit<StudioProblem, "message">>();
  for (const l of snapshot.lessons) {
    owner.set(l.id, { lesson: l.id });
    for (const item of l.quiz) owner.set(item.id, { lesson: l.id });
    for (const section of l.sections) {
      owner.set(section.id, { section: section.id });
      for (const block of section.blocks) owner.set(block.id, { section: section.id });
    }
  }
  for (const m of snapshot.misconceptions) owner.set(m.id, { lesson: m.lesson });
  for (const o of snapshot.objectives ?? []) owner.set(o.id, { lesson: o.lesson });
  return error
    .split("\n- ")
    .slice(1)
    .map((line) => ({ ...[...line.matchAll(/"([^"]+)"/g)].map((match) => owner.get(match[1]!)).find(Boolean), message: line }));
}
