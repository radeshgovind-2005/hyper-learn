import { z } from "zod";
import { type QuizItem, Slug } from "../assessment/items.js";

// Schemas for content/<course>/course.json. The ```quiz block at the end of each lesson file holds
// items from src/assessment/items.ts.
// Strict objects reject unknown keys, so a typo in the content fails at load time.

const LessonId = Slug;

/** A named belief that wrong answers reveal, e.g. "the model runs the tools itself". */
export const MisconceptionDefSchema = z.strictObject({
  id: Slug,
  /** The lesson that teaches the correct idea; wrong answers tagged with it point to this lesson. */
  lesson: LessonId,
  /** The belief, stated as the learner would hold it. */
  belief: z.string().min(1),
});
export type MisconceptionDef = z.infer<typeof MisconceptionDefSchema>;

/**
 * What mastering a lesson means, one testable statement at a time ("explain why an Exchange appears
 * in the plan"). Exam items name the objective they test; a wrong answer then points the learner at
 * the sections that teach it. Optional: a course without objectives works as before.
 */
export const ObjectiveSchema = z.strictObject({
  id: Slug,
  /** The lesson whose exam tests it. */
  lesson: LessonId,
  statement: z.string().min(1),
  /** Ids of the sections that teach it (`<lesson>/<slug>`), in reading order. May be empty. */
  sections: z.array(z.string().min(1)).default([]),
});
export type Objective = z.infer<typeof ObjectiveSchema>;

/**
 * How a lesson's exam is drawn from its question pool. Absent: every quiz item, every time (as before).
 * Present: `per_objective` scored items per objective, preferring items the learner hasn't seen.
 */
export const ExamConfigSchema = z.strictObject({
  per_objective: z.number().int().min(1).max(3),
});
export type ExamConfig = z.infer<typeof ExamConfigSchema>;

/** Where a piece of generated content comes from: a source document and a 1-based page. */
export const CitationSchema = z.strictObject({
  source: z.string().min(1),
  page: z.number().int().min(1),
});
export type Citation = z.infer<typeof CitationSchema>;

export const LessonMetaSchema = z.strictObject({
  id: LessonId,
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Path of the lesson's Markdown file, relative to the course directory. */
  file: z.string().min(1),
  prerequisites: z.array(LessonId),
});
export type LessonMeta = z.infer<typeof LessonMetaSchema>;

export const CourseManifestSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  lessons: z.array(LessonMetaSchema).min(1),
  misconceptions: z.array(MisconceptionDefSchema).default([]),
});
export type CourseManifest = z.infer<typeof CourseManifestSchema>;

export interface Lesson extends LessonMeta {
  /** Lesson text in Markdown, without the quiz block. */
  body: string;
  quiz: QuizItem[];
}

/** Lesson id → ids of its direct prerequisites. */
export type PrereqGraph = Readonly<Record<string, readonly string[]>>;

export interface Course {
  id: string;
  title: string;
  lessons: Lesson[];
  /** The course's intended (correct) prerequisite structure. */
  graph: PrereqGraph;
  misconceptions: MisconceptionDef[];
  /** Learning objectives; empty for courses that don't define them. */
  objectives: Objective[];
  getLesson(id: string): Lesson | undefined;
  getMisconception(id: string): MisconceptionDef | undefined;
}
