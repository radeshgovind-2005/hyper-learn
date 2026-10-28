import { z } from "zod";

// Schemas for content/<course>/course.json and the ```quiz block at the end of each lesson file.
// Strict objects reject unknown keys, so a typo in the content fails at load time.

const LessonId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lesson ids must be kebab-case");

export const QuizOptionSchema = z.strictObject({
  text: z.string().min(1),
  correct: z.boolean().default(false),
  /** The lesson a learner who picks this wrong option probably missed. Untagged = a gap in this lesson. */
  reveals_gap_in: LessonId.optional(),
});
export type QuizOption = z.infer<typeof QuizOptionSchema>;

export const QuizQuestionSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(QuizOptionSchema).min(2),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizSchema = z.array(QuizQuestionSchema).min(1);

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
});
export type CourseManifest = z.infer<typeof CourseManifestSchema>;

export interface Lesson extends LessonMeta {
  /** Lesson text in Markdown, without the quiz block. */
  body: string;
  quiz: QuizQuestion[];
}

/** Lesson id → ids of its direct prerequisites. */
export type PrereqGraph = Readonly<Record<string, readonly string[]>>;

export interface Course {
  id: string;
  title: string;
  lessons: Lesson[];
  /** The course's intended (correct) prerequisite structure. */
  graph: PrereqGraph;
  getLesson(id: string): Lesson | undefined;
}
