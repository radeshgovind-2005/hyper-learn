import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ancestorsOf, findCycle } from "./graph.js";
import {
  type Course,
  CourseManifestSchema,
  type Lesson,
  type LessonMeta,
  type PrereqGraph,
  QuizSchema,
} from "./schema.js";

export const DEFAULT_COURSE_DIR = fileURLToPath(new URL("../../content/agentic-coding/", import.meta.url));

const QUIZ_BLOCK = /```quiz\s*\n([\s\S]*?)\n```/g;

/** Splits a lesson file into its Markdown body and its validated quiz. */
export function parseLessonFile(meta: LessonMeta, markdown: string): Lesson {
  const blocks = [...markdown.matchAll(QUIZ_BLOCK)];
  if (blocks.length !== 1) {
    throw new Error(`Lesson "${meta.id}" must contain exactly one \`\`\`quiz block (found ${blocks.length})`);
  }

  let quizJson: unknown;
  try {
    quizJson = JSON.parse(blocks[0]![1]!);
  } catch (error) {
    throw new Error(`Lesson "${meta.id}" has invalid JSON in its quiz block: ${(error as Error).message}`);
  }

  const quiz = QuizSchema.safeParse(quizJson);
  if (!quiz.success) {
    throw new Error(`Lesson "${meta.id}" has an invalid quiz:\n${quiz.error.message}`);
  }

  return { ...meta, body: markdown.replace(blocks[0]![0], "").trim(), quiz: quiz.data };
}

export const toGraph = (lessons: readonly LessonMeta[]): PrereqGraph =>
  Object.fromEntries(lessons.map((lesson) => [lesson.id, lesson.prerequisites]));

/**
 * Cross-lesson rules the schemas can't express. Returns every problem found (empty = valid):
 * unique ids, known acyclic prerequisites, one correct option per question, gap tags that point
 * at real ancestors, and every direct prerequisite tagged at least once so its absence is detectable.
 */
export function validateCourse(lessons: readonly Lesson[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const questionIds = new Set<string>();

  for (const lesson of lessons) {
    if (ids.has(lesson.id)) problems.push(`Duplicate lesson id "${lesson.id}"`);
    ids.add(lesson.id);
  }

  for (const lesson of lessons) {
    for (const prereq of lesson.prerequisites) {
      if (prereq === lesson.id) problems.push(`Lesson "${lesson.id}" lists itself as a prerequisite`);
      else if (!ids.has(prereq)) problems.push(`Lesson "${lesson.id}" has unknown prerequisite "${prereq}"`);
    }
  }

  const graph = toGraph(lessons);
  const cycle = findCycle(graph);
  if (cycle) {
    problems.push(`Prerequisites form a cycle: ${cycle.join(" → ")}`);
    return problems; // ancestor checks below assume an acyclic graph
  }

  for (const lesson of lessons) {
    const ancestors = ancestorsOf(graph, lesson.id);
    const tagged = new Set<string>();

    for (const question of lesson.quiz) {
      const where = `Question "${question.id}" in "${lesson.id}"`;
      if (questionIds.has(question.id)) problems.push(`Duplicate question id "${question.id}"`);
      questionIds.add(question.id);

      const correct = question.options.filter((option) => option.correct);
      if (correct.length !== 1) problems.push(`${where} must have exactly one correct option (has ${correct.length})`);

      for (const option of question.options) {
        const gap = option.reveals_gap_in;
        if (gap === undefined) continue;
        if (option.correct) problems.push(`${where}: the correct option can't reveal a gap`);
        else if (!ancestors.has(gap)) problems.push(`${where}: reveals_gap_in "${gap}" is not a prerequisite of "${lesson.id}"`);
        tagged.add(gap);
      }
    }

    for (const prereq of lesson.prerequisites) {
      if (!tagged.has(prereq)) {
        problems.push(`Lesson "${lesson.id}": no wrong option reveals a gap in prerequisite "${prereq}"`);
      }
    }
  }

  return problems;
}

export function buildCourse(manifest: { id: string; title: string }, lessons: Lesson[]): Course {
  const problems = validateCourse(lessons);
  if (problems.length > 0) {
    throw new Error(`Course "${manifest.id}" is invalid:\n- ${problems.join("\n- ")}`);
  }
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  return {
    id: manifest.id,
    title: manifest.title,
    lessons,
    graph: toGraph(lessons),
    getLesson: (id) => byId.get(id),
  };
}

/** Reads and validates a course directory: course.json plus one Markdown file per lesson. */
export function loadCourse(dir: string = DEFAULT_COURSE_DIR): Course {
  const manifest = CourseManifestSchema.parse(JSON.parse(readFileSync(join(dir, "course.json"), "utf8")));
  const lessons = manifest.lessons.map((meta) => parseLessonFile(meta, readFileSync(join(dir, meta.file), "utf8")));
  return buildCourse(manifest, lessons);
}

let cached: Course | undefined;

/** The default course, loaded once. */
export function getCourse(): Course {
  cached ??= loadCourse();
  return cached;
}
