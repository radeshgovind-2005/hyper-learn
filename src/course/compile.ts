import type { QuizItem } from "../assessment/items.js";
import { type Intervention, InterventionSchema } from "../interventions/templates.js";
import { buildCourse } from "./load.js";
import type { Course, MisconceptionDef } from "./schema.js";

// The course as a content graph: lessons contain sections, sections contain blocks. Compiled once
// from the Markdown lessons into release v1.0.0; after that, releases (not the Markdown) are the
// source of truth, and every change is an operation on this snapshot. Ids are stable: a block keeps
// its id across releases, so diffs, measurements and learner paths can refer to it.

export type TextKind = "paragraph" | "list" | "code";
export type BlockKind = TextKind | "intervention";

interface BlockBase {
  /** `<lesson>/<section>/<p|l|c|i><n>`, e.g. `agent-loop/stopping/p1`. */
  id: string;
  archived: boolean;
}

export interface TextBlock extends BlockBase {
  kind: TextKind;
  /** The block's Markdown, exactly as it appears in the lesson. */
  markdown: string;
}

/** A templated intervention aimed at one misconception. Shown to the learners who show that belief. */
export interface InterventionBlock extends BlockBase {
  kind: "intervention";
  intervention: Intervention;
}

export type Block = TextBlock | InterventionBlock;

export interface Section {
  /** `<lesson>/<slug>`; the text before the first heading is the `intro` section. */
  id: string;
  /** The `## ` heading; empty for the intro. */
  title: string;
  blocks: Block[];
  archived: boolean;
}

export interface LessonNode {
  id: string;
  title: string;
  summary: string;
  prerequisites: string[];
  sections: Section[];
  quiz: QuizItem[];
  archived: boolean;
}

export interface CourseSnapshot {
  course_id: string;
  title: string;
  /** Semantic version of this release, e.g. "1.0.0". */
  version: string;
  lessons: LessonNode[];
  misconceptions: MisconceptionDef[];
}

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const KIND_PREFIX: Record<BlockKind, string> = { paragraph: "p", list: "l", code: "c", intervention: "i" };

/** Splits Markdown into blocks at blank lines, keeping fenced code blocks whole. */
export function splitBlocks(markdown: string): { kind: TextKind; markdown: string }[] {
  const blocks: { kind: TextKind; markdown: string }[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (!text) return;
    const kind: TextKind = text.startsWith("```") ? "code" : /^([-*]|\d+\.)\s/.test(text) ? "list" : "paragraph";
    blocks.push({ kind, markdown: text });
  };

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (!inFence && line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** Splits a lesson body (without its quiz) into sections at `## ` headings. The `# ` title line is dropped. */
export function compileSections(lessonId: string, body: string): Section[] {
  const lines = body.split("\n");
  const start = lines[0]?.startsWith("# ") ? 1 : 0;
  const parts: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  for (const line of lines.slice(start)) {
    if (line.startsWith("## ")) parts.push({ title: line.slice(3).trim(), lines: [] });
    else parts.at(-1)!.lines.push(line);
  }

  const used = new Set<string>();
  return parts
    .filter((part, i) => i > 0 || part.lines.some((line) => line.trim() !== ""))
    .map((part) => {
      let slug = part.title ? slugify(part.title) : "intro";
      for (let n = 2; used.has(slug); n++) slug = `${slugify(part.title)}-${n}`;
      used.add(slug);
      const id = `${lessonId}/${slug}`;
      const counters: Record<TextKind, number> = { paragraph: 0, list: 0, code: 0 };
      return {
        id,
        title: part.title,
        archived: false,
        blocks: splitBlocks(part.lines.join("\n")).map((block): Block => ({
          id: `${id}/${KIND_PREFIX[block.kind]}${++counters[block.kind]}`,
          kind: block.kind,
          markdown: block.markdown,
          archived: false,
        })),
      };
    });
}

/** Compiles a loaded (and validated) course into its first release. */
export function compileCourse(course: Course, version = "1.0.0"): CourseSnapshot {
  return {
    course_id: course.id,
    title: course.title,
    version,
    misconceptions: course.misconceptions,
    lessons: course.lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      prerequisites: [...lesson.prerequisites],
      sections: compileSections(lesson.id, lesson.body),
      quiz: lesson.quiz,
      archived: false,
    })),
  };
}

/**
 * A lesson's Markdown as every learner sees it in this release. Archived sections and blocks are left
 * out, and so are interventions: those are shown only to learners who show their misconception.
 */
export function renderLesson(lesson: LessonNode): string {
  const parts = [`# ${lesson.title}`];
  for (const section of lesson.sections) {
    if (section.archived) continue;
    if (section.title) parts.push(`## ${section.title}`);
    for (const block of section.blocks) if (!block.archived && block.kind !== "intervention") parts.push(block.markdown);
  }
  return parts.join("\n\n");
}

export interface LiveIntervention {
  block_id: string;
  lesson: string;
  section: string;
  intervention: Intervention;
}

/** The interventions learners can be shown in this release (not archived, in a live section and lesson). */
export function liveInterventions(snapshot: CourseSnapshot): LiveIntervention[] {
  return snapshot.lessons
    .filter((lesson) => !lesson.archived)
    .flatMap((lesson) =>
      lesson.sections
        .filter((section) => !section.archived)
        .flatMap((section) =>
          section.blocks.flatMap((block) =>
            block.kind === "intervention" && !block.archived
              ? [{ block_id: block.id, lesson: lesson.id, section: section.id, intervention: block.intervention }]
              : [],
          ),
        ),
    );
}

/**
 * The course view the rest of the system works with (analytics, simulation, tools), built from a
 * snapshot and validated with the same rules as the Markdown course. Archived lessons are left out.
 * Throws if the snapshot breaks a course invariant, which is how a candidate release is checked;
 * that includes every intervention block being well-formed and aimed at a misconception its lesson teaches.
 */
export function courseFromSnapshot(snapshot: CourseSnapshot): Course {
  const lessons = snapshot.lessons.filter((lesson) => !lesson.archived);
  const problems: string[] = [];
  for (const lesson of lessons) {
    for (const block of lesson.sections.flatMap((section) => section.blocks)) {
      if (block.kind !== "intervention") continue;
      const parsed = InterventionSchema.safeParse(block.intervention);
      if (!parsed.success) problems.push(`Block "${block.id}" is not a valid intervention: ${parsed.error.message}`);
      const target = snapshot.misconceptions.find((m) => m.id === block.intervention.targets);
      if (!target) problems.push(`Block "${block.id}" targets unknown misconception "${block.intervention.targets}"`);
      else if (target.lesson !== lesson.id) {
        problems.push(`Block "${block.id}" targets "${target.id}", which is taught in "${target.lesson}", not "${lesson.id}"`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`Course "${snapshot.course_id}" is invalid:\n- ${problems.join("\n- ")}`);
  return buildCourse(
    { id: snapshot.course_id, title: snapshot.title, misconceptions: snapshot.misconceptions },
    lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      file: `${lesson.id}@${snapshot.version}`,
      prerequisites: lesson.prerequisites,
      body: renderLesson(lesson),
      quiz: lesson.quiz,
    })),
  );
}
