import type { QuizItem } from "../assessment/items.js";
import { buildCourse } from "./load.js";
import type { Course, MisconceptionDef } from "./schema.js";

// The course as a content graph: lessons contain sections, sections contain blocks. Compiled once
// from the Markdown lessons into release v1.0.0; after that, releases (not the Markdown) are the
// source of truth, and every change is an operation on this snapshot. Ids are stable: a block keeps
// its id across releases, so diffs, measurements and learner paths can refer to it.

export type BlockKind = "paragraph" | "list" | "code";

export interface Block {
  /** `<lesson>/<section>/<p|l|c><n>`, e.g. `agent-loop/stopping/p1`. */
  id: string;
  kind: BlockKind;
  /** The block's Markdown, exactly as it appears in the lesson. */
  markdown: string;
  archived: boolean;
}

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

const KIND_PREFIX: Record<BlockKind, string> = { paragraph: "p", list: "l", code: "c" };

/** Splits Markdown into blocks at blank lines, keeping fenced code blocks whole. */
export function splitBlocks(markdown: string): { kind: BlockKind; markdown: string }[] {
  const blocks: { kind: BlockKind; markdown: string }[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (!text) return;
    const kind: BlockKind = text.startsWith("```") ? "code" : /^([-*]|\d+\.)\s/.test(text) ? "list" : "paragraph";
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
      const counters: Record<BlockKind, number> = { paragraph: 0, list: 0, code: 0 };
      return {
        id,
        title: part.title,
        archived: false,
        blocks: splitBlocks(part.lines.join("\n")).map((block) => ({
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

/** A lesson's Markdown as learners see it in this release: archived sections and blocks are left out. */
export function renderLesson(lesson: LessonNode): string {
  const parts = [`# ${lesson.title}`];
  for (const section of lesson.sections) {
    if (section.archived) continue;
    if (section.title) parts.push(`## ${section.title}`);
    for (const block of section.blocks) if (!block.archived) parts.push(block.markdown);
  }
  return parts.join("\n\n");
}

/**
 * The course view the rest of the system works with (analytics, simulation, tools), built from a
 * snapshot and validated with the same rules as the Markdown course. Archived lessons are left out.
 * Throws if the snapshot breaks a course invariant, which is how a candidate release is checked.
 */
export function courseFromSnapshot(snapshot: CourseSnapshot): Course {
  const lessons = snapshot.lessons.filter((lesson) => !lesson.archived);
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
