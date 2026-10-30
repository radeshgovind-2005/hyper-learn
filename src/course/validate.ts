import { wrongOptions } from "../assessment/answers.js";
import { checkItem, itemTags, QuizSchema } from "../assessment/items.js";
import { ancestorsOf, findCycle } from "./graph.js";
import type { Course, Lesson, LessonMeta, MisconceptionDef, Objective, PrereqGraph } from "./schema.js";

// Course validation and assembly, with no I/O, so it runs anywhere (Node, the Worker, tests).

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
 * With objectives, also the rules of validateObjectives.
 */
export function validateCourse(
  lessons: readonly Lesson[],
  misconceptions: readonly MisconceptionDef[] = [],
  objectives: readonly Objective[] = [],
): string[] {
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

  return [...problems, ...validateObjectives(lessons, objectives)];
}

/**
 * Objective rules: unique ids, each in a known lesson; every item that names an objective names one of
 * its own lesson's; in a lesson with objectives, every scored item names one; and each objective has
 * enough scored items for a retake to be fresh (2 × per_objective with an exam config, else at least 1).
 */
export function validateObjectives(lessons: readonly Lesson[], objectives: readonly Objective[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, Objective>();
  const lessonIds = new Set(lessons.map((lesson) => lesson.id));
  for (const o of objectives) {
    if (byId.has(o.id)) problems.push(`Duplicate objective id "${o.id}"`);
    if (!lessonIds.has(o.lesson)) problems.push(`Objective "${o.id}" belongs to unknown lesson "${o.lesson}"`);
    byId.set(o.id, o);
  }

  for (const lesson of lessons) {
    const own = objectives.filter((o) => o.lesson === lesson.id);
    for (const item of lesson.quiz) {
      const where = `Question "${item.id}" in "${lesson.id}"`;
      if (item.objective === undefined) {
        if (own.length > 0 && !item.pilot) problems.push(`${where} must name one of the lesson's objectives`);
        continue;
      }
      const o = byId.get(item.objective);
      if (!o) problems.push(`${where}: unknown objective "${item.objective}"`);
      else if (o.lesson !== lesson.id) problems.push(`${where}: objective "${o.id}" belongs to "${o.lesson}", not "${lesson.id}"`);
    }
    const needed = 2 * (lesson.exam?.per_objective ?? 0) || 1;
    for (const o of own) {
      const n = lesson.quiz.filter((item) => !item.pilot && item.objective === o.id).length;
      if (n < needed) problems.push(`Objective "${o.id}" has ${n} scored question${n === 1 ? "" : "s"}; it needs at least ${needed}`);
    }
  }
  return problems;
}

export function buildCourse(
  manifest: { id: string; title: string; misconceptions?: MisconceptionDef[]; objectives?: Objective[] },
  lessons: Lesson[],
): Course {
  const misconceptions = manifest.misconceptions ?? [];
  const problems = validateCourse(lessons, misconceptions, manifest.objectives ?? []);
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
    objectives: manifest.objectives ?? [],
    getLesson: (id) => byId.get(id),
    getMisconception: (id) => misconceptionById.get(id),
  };
}
