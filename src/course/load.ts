import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrongOptions } from "../assessment/answers.js";
import { checkItem, itemTags, QuizSchema } from "../assessment/items.js";
import { ancestorsOf, findCycle } from "./graph.js";
import {
  type Course,
  CourseManifestSchema,
  type Lesson,
  type LessonMeta,
  type MisconceptionDef,
  type PrereqGraph,
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
 * Rules the schemas can't express. Returns every problem found (empty = valid):
 * unique ids; known, acyclic prerequisites; well-formed items; gap tags that point at an earlier
 * lesson (one that doesn't depend on this one; it needn't be a prerequisite yet, since that is how a
 * missing prerequisite shows up); misconception tags that exist and point at the lesson that teaches them; every tagged
 * wrong answer reachable; every direct prerequisite and every named misconception detectable.
 */
export function validateCourse(lessons: readonly Lesson[], misconceptions: readonly MisconceptionDef[] = []): string[] {
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

  const catalog = new Map<string, MisconceptionDef>();
  for (const m of misconceptions) {
    if (catalog.has(m.id)) problems.push(`Duplicate misconception id "${m.id}"`);
    if (!ids.has(m.lesson)) problems.push(`Misconception "${m.id}" belongs to unknown lesson "${m.lesson}"`);
    catalog.set(m.id, m);
  }

  const graph = toGraph(lessons);
  const cycle = findCycle(graph);
  if (cycle) {
    problems.push(`Prerequisites form a cycle: ${cycle.join(" → ")}`);
    return problems; // ancestor checks below assume an acyclic graph
  }

  const detected = new Set<string>();
  for (const lesson of lessons) {
    const tagged = new Set<string>();

    for (const item of lesson.quiz) {
      const where = `Question "${item.id}" in "${lesson.id}"`;
      if (questionIds.has(item.id)) problems.push(`Duplicate question id "${item.id}"`);
      questionIds.add(item.id);

      for (const problem of checkItem(item)) problems.push(`${where}: ${problem}`);

      for (const tag of itemTags(item)) {
        const gap = tag.reveals_gap_in;
        if (gap !== undefined) {
          if (!ids.has(gap)) problems.push(`${where}: reveals_gap_in "${gap}" is not a lesson`);
          else if (gap === lesson.id || ancestorsOf(graph, gap).has(lesson.id)) {
            problems.push(`${where}: reveals_gap_in "${gap}" depends on "${lesson.id}", so it can't be a gap behind it`);
          }
          tagged.add(gap);
        }
        if (tag.misconception !== undefined) {
          const m = catalog.get(tag.misconception);
          if (!m) problems.push(`${where}: unknown misconception "${tag.misconception}"`);
          else if (m.lesson !== (gap ?? lesson.id)) {
            problems.push(
              `${where}: misconception "${m.id}" belongs to "${m.lesson}", so the answer must point there ` +
                `(reveals_gap_in ${gap === undefined ? "is missing" : `is "${gap}"`})`,
            );
          }
          detected.add(tag.misconception);
        }
      }

      if (problems.length === 0) {
        const reachable = new Set(wrongOptions(item, lesson.id).map((o) => o.reveals.misconception));
        for (const tag of itemTags(item)) {
          if (tag.misconception && !reachable.has(tag.misconception)) {
            problems.push(`${where}: no answer can reveal "${tag.misconception}"`);
          }
        }
      }
    }

    for (const prereq of lesson.prerequisites) {
      if (!tagged.has(prereq)) {
        problems.push(`Lesson "${lesson.id}": no wrong option reveals a gap in prerequisite "${prereq}"`);
      }
    }
  }

  for (const m of misconceptions) {
    if (!detected.has(m.id)) problems.push(`Misconception "${m.id}" is never revealed by any wrong answer`);
  }

  return problems;
}

export function buildCourse(
  manifest: { id: string; title: string; misconceptions?: MisconceptionDef[] },
  lessons: Lesson[],
): Course {
  const misconceptions = manifest.misconceptions ?? [];
  const problems = validateCourse(lessons, misconceptions);
  if (problems.length > 0) {
    throw new Error(`Course "${manifest.id}" is invalid:\n- ${problems.join("\n- ")}`);
  }
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const misconceptionById = new Map(misconceptions.map((m) => [m.id, m]));
  return {
    id: manifest.id,
    title: manifest.title,
    lessons,
    graph: toGraph(lessons),
    misconceptions,
    getLesson: (id) => byId.get(id),
    getMisconception: (id) => misconceptionById.get(id),
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
