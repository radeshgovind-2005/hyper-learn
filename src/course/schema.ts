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
  getLesson(id: string): Lesson | undefined;
  getMisconception(id: string): MisconceptionDef | undefined;
}
