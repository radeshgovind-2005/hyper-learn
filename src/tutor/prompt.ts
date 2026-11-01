import type { CourseSnapshot } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import { liveLesson, liveSection, sectionText } from "./tools.js";

// The context a tutor turn starts from, built by code: the lesson and its outline, the section in view
// and the text of the pages it cites, the files the learner may open, and what they recently got
// wrong. No vector search: a lesson and a few pages fit easily in Spark's window. Never an answer key.

export interface TurnContext {
  courseTitle: string;
  snapshot: CourseSnapshot;
  lesson: string;
  section?: string;
  cited: readonly { id: string; name: string; pages: number }[];
  /** Page text by citation, for the section in view (at most a few pages). */
  pages: readonly { cite: Citation; text: string }[];
  /** What the learner recently got wrong or said, one line each (no correct answers). */
  missed: readonly string[];
  /** What earlier messages were folded into. */
  summary: string | null;
}

const MAX_CONTEXT_PAGE_CHARS = 6_000;

export function contextMessage(ctx: TurnContext): string {
  const lesson = liveLesson(ctx.snapshot, ctx.lesson);
  if (!lesson) throw new Error(`No lesson "${ctx.lesson}"`);
  const inView = ctx.section ? liveSection(ctx.snapshot, ctx.section) : undefined;
  const objectives = (ctx.snapshot.objectives ?? []).filter((o) => o.lesson === lesson.id).map((o) => `- ${o.statement}`);
  const outline = lesson.sections.filter((s) => !s.archived).map((s) => `- ${s.id}: ${s.title || "(introduction)"}`);
  return [
    `Course: ${ctx.courseTitle}`,
    `Lesson "${lesson.title}" [${lesson.id}]: ${lesson.summary}`,
    objectives.length > 0 && `It teaches:\n${objectives.join("\n")}`,
    `Sections (ids for the tools):\n${outline.join("\n")}`,
    inView ? `The learner is reading this section now:\n${sectionText(inView.section)}` : "The learner is at the top of the lesson.",
    ctx.pages.length > 0 &&
      `The pages that section cites:\n${ctx.pages.map((p) => `<source id="${p.cite.source}" page="${p.cite.page}">\n${p.text.slice(0, MAX_CONTEXT_PAGE_CHARS)}\n</source>`).join("\n")}`,
    ctx.cited.length > 0 ? `Files the learner may open: ${ctx.cited.map((s) => `${s.id} "${s.name}" (${s.pages} pages)`).join("; ")}` : "This course has no source files to open.",
    ctx.missed.length > 0 ? `What the learner recently got wrong or told you:\n${ctx.missed.map((m) => `- ${m}`).join("\n")}` : "No recent wrong answers on this lesson.",
    ctx.summary && `Earlier in this conversation:\n${ctx.summary}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
