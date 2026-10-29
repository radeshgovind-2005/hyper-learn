import type { QuizItem } from "../assessment/items.js";
import type { Course } from "../course/schema.js";
import { type Intervention, interventionQuestions, interventionTexts } from "./templates.js";

// Code checks an intervention must pass before review and before any release can include it.

/** Question prompts sharing at least this much vocabulary with a quiz prompt are leaks. */
export const PROMPT_OVERLAP_LIMIT = 0.7;
/** A correct answer this close to a quiz item's correct answer gives the quiz away. */
export const ANSWER_OVERLAP_LIMIT = 0.8;

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are be it its this that as by at from what which who how why when does do not no can".split(" "),
);

/** Content words, lowercased: the vocabulary two texts share is what makes one give the other away. */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9_]+/g)
      ?.filter((word) => word.length > 2 && !STOPWORDS.has(word)) ?? [],
  );
}

/** Share of the smaller text's content words that also appear in the other (0–1). */
export function overlap(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** A quiz item's prompts and the texts of its correct answers. */
export function quizTexts(item: QuizItem): { prompts: string[]; answers: string[] } {
  switch (item.type) {
    case "single_choice":
    case "multi_select":
      return { prompts: [item.prompt], answers: item.options.filter((o) => o.correct).map((o) => o.text) };
    case "two_tier":
      return {
        prompts: [item.prompt, item.reason_prompt],
        answers: [...item.options, ...item.reasons].filter((o) => o.correct).map((o) => o.text),
      };
    case "ordering":
      return { prompts: [item.prompt], answers: [item.steps.join(" ")] };
    case "matching":
      return { prompts: [item.prompt], answers: item.left.map((left, i) => `${left} ${item.right[i]}`) };
    case "cloze":
      return { prompts: [item.prompt, item.text], answers: [item.text.replace(/\{\{(\d+)\}\}/g, (_, i) => item.blanks[Number(i)]!.accept[0]!)] };
    case "parsons":
      return { prompts: [item.prompt], answers: [item.lines.join("\n")] };
    case "schema_completion":
      return { prompts: [item.prompt], answers: [item.example] };
    case "short_answer":
      return { prompts: [item.prompt], answers: [item.reference_answer] };
  }
}

export interface InterventionContext {
  course: Course;
  /** The lesson the intervention will be attached to. */
  lessonId: string;
  /** The misconception the diagnosis chose; the intervention must target exactly this one. */
  misconception: string;
  /** Live interventions already in the course. */
  existing: readonly Intervention[];
}

const UNSAFE_MARKUP = /<\s*[a-z!/]|javascript:|\]\(\s*[a-z]+:/i;

/** Returns every problem found (empty = passes). */
export function checkIntervention(intervention: Intervention, { course, lessonId, misconception, existing }: InterventionContext): string[] {
  const problems: string[] = [];

  if (intervention.targets !== misconception) {
    problems.push(`targets "${intervention.targets}", but the diagnosis is about "${misconception}"`);
  }
  const target = course.getMisconception(intervention.targets);
  if (!target) problems.push(`"${intervention.targets}" is not in the misconception catalog`);
  else if (target.lesson !== lessonId) problems.push(`"${target.id}" is taught in "${target.lesson}", not "${lessonId}"`);

  if (existing.some((other) => other.targets === intervention.targets && other.template === intervention.template)) {
    problems.push(`a ${intervention.template} for "${intervention.targets}" is already live`);
  }

  for (const value of interventionTexts(intervention)) {
    if (UNSAFE_MARKUP.test(value)) problems.push(`markup or links are not allowed: "${value.slice(0, 60)}"`);
  }

  const questions = interventionQuestions(intervention);
  questions.forEach((question, i) => {
    const where = `question ${i + 1}`;
    const correct = question.options.filter((o) => o.correct).length;
    if (correct !== 1) problems.push(`${where} must have exactly one correct option (has ${correct})`);
    for (const option of question.options) {
      if (option.correct && option.misconception) problems.push(`${where}: the correct option can't express a misconception`);
      if (option.misconception && !course.getMisconception(option.misconception)) {
        problems.push(`${where}: unknown misconception "${option.misconception}"`);
      }
    }
  });
  if (questions.length > 0 && !questions.some((q) => q.options.some((o) => !o.correct && o.misconception === intervention.targets))) {
    problems.push(`no wrong option expresses "${intervention.targets}", so the questions don't test the belief`);
  }

  if (intervention.template === "step_through") {
    intervention.frames.forEach((frame, i) => {
      if (frame.highlight !== null && frame.highlight >= frame.messages.length) problems.push(`frame ${i + 1}: highlight out of range`);
    });
  }

  // Practice must not teach to the test: no quiz prompt reworded, no quiz answer handed over.
  const quiz = course.lessons.flatMap((lesson) => lesson.quiz.map((item) => ({ lesson, item, ...quizTexts(item) })));
  for (const [i, question] of questions.entries()) {
    const answer = question.options.find((o) => o.correct)?.text ?? "";
    for (const { item, prompts, answers } of quiz) {
      if (prompts.some((prompt) => overlap(question.prompt, prompt) >= PROMPT_OVERLAP_LIMIT)) {
        problems.push(`question ${i + 1} repeats quiz question "${item.id}"`);
      }
      if (answers.some((quizAnswer) => overlap(answer, quizAnswer) >= ANSWER_OVERLAP_LIMIT)) {
        problems.push(`question ${i + 1}'s answer gives away quiz question "${item.id}"`);
      }
    }
  }

  return [...new Set(problems)];
}
