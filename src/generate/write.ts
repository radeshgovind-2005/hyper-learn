import { splitBlocks, type TextKind } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import { citedPage, type Source } from "../course/sources.js";
import { type CheckQuestion, CheckQuestionSchema } from "../interventions/templates.js";
import type { PlannedLesson, PlannedSection } from "./plan.js";
import { fitParts, languageLine, pageLabel, type Part } from "./prompt.js";
import type { SectionDraft } from "./schemas.js";
import type { BuildInput } from "./types.js";

// Step 4: each section is written from its planned pages only. Code checks that every block cites
// one of those pages, sanitizes the Markdown (the web app renders it as HTML), and turns the
// practice question into a check block whose options carry no misconception yet.

export interface WrittenBlock {
  kind: TextKind;
  markdown: string;
  cites: Citation[];
}

export interface WrittenSection {
  blocks: WrittenBlock[];
  check: CheckQuestion;
}

/** Inline code is left alone; elsewhere images become their alt text, links keep only http(s) targets, and `<` can't open a tag. */
const cleanInline = (text: string) =>
  text
    .split(/(`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (link, label: string, url: string) => (/^https?:\/\//i.test(url) ? link : label))
            .replace(/</g, "&lt;"),
    )
    .join("");

/**
 * Generated Markdown as the app may render it: headings become bold lines (a `## ` line would start a
 * new section when the lesson is rendered), no raw HTML, no images, links only to http(s). Fenced code
 * is kept as written; an unclosed fence is closed.
 */
export function sanitizeMarkdown(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else {
      out.push(cleanInline(line.replace(/^\s{0,3}#{1,6}\s+(.+?)[\s#]*$/, "**$1**")));
    }
  }
  if (inFence) out.push("```");
  return out.join("\n").trim();
}

export interface WriterContext {
  input: BuildInput;
  sources: readonly Source[];
  lesson: PlannedLesson;
  section: PlannedSection;
}

/** The writer's user message: the section's place in the lesson, its objectives, and its pages (shortened to fit). */
export function writerPrompt({ input, sources, lesson, section }: WriterContext, room: number, retry?: string): string {
  const objectives = lesson.objectives.filter((o) => o.sections.includes(section.id)).map((o) => `- ${o.statement}`);
  const others = lesson.sections.filter((s) => s.id !== section.id).map((s) => `"${s.title}"`);
  const header = [
    `Course: ${input.title}`,
    `Lesson: ${lesson.title}. ${lesson.summary}`,
    others.length > 0 && `Other sections of this lesson (leave their topics to them): ${others.join(", ")}`,
    `Write the section "${section.title}".`,
    objectives.length > 0 && `It teaches:\n${objectives.join("\n")}`,
    languageLine(input.language),
    `Cite only these pages: ${section.pages.map(pageLabel).join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
  const pages: Part[] = section.pages.map((ref) => ({
    text: citedPage(sources, ref) ?? "",
    elastic: true,
    before: `<source id="${ref.source}" page="${ref.page}">\n`,
    after: "\n</source>",
  }));
  return fitParts([{ text: header }, ...pages, ...(retry ? [{ text: retry }] : [])], room);
}

/** Checks a section draft against its planned pages and builds the section, or lists what to fix. */
export function sectionFromDraft(draft: SectionDraft, section: PlannedSection): { section?: WrittenSection; problems: string[] } {
  const problems: string[] = [];
  const allowed = section.pages.map(pageLabel);
  const blocks: WrittenBlock[] = [];

  draft.blocks.forEach((block, i) => {
    const markdown = sanitizeMarkdown(block.markdown);
    if (!markdown) return;
    const cites: Citation[] = [];
    for (const ref of block.cites) {
      if (!allowed.includes(pageLabel(ref))) problems.push(`block ${i + 1} cites ${pageLabel(ref)}, which is not one of this section's pages (${allowed.join(", ")})`);
      else if (!cites.some((c) => pageLabel(c) === pageLabel(ref))) cites.push({ source: ref.source, page: ref.page });
    }
    if (block.cites.length === 0) problems.push(`block ${i + 1} cites no page; every block must cite the pages it is based on`);
    for (const part of splitBlocks(markdown)) blocks.push({ ...part, cites });
  });
  if (blocks.length === 0) problems.push("the section has no text blocks");

  const options = draft.check.options.map((o) => ({ text: o.text.trim(), correct: o.correct, misconception: null, feedback: o.feedback.trim() }));
  const correct = options.filter((o) => o.correct).length;
  if (correct !== 1) problems.push(`the practice question must have exactly one correct option (has ${correct})`);
  const check = CheckQuestionSchema.safeParse({ prompt: draft.check.prompt.trim(), options });
  if (!check.success) {
    for (const issue of check.error.issues) problems.push(`practice question ${issue.path.join(".") || "(whole)"}: ${issue.message}`);
  }

  return problems.length > 0 || !check.success ? { problems } : { section: { blocks, check: check.data }, problems };
}

/** The section's text with its citations, for the fact checker. */
export function sectionText(written: WrittenSection): string {
  return written.blocks.map((b, i) => `[${i + 1}] (cites ${b.cites.map(pageLabel).join(", ")})\n${b.markdown}`).join("\n\n");
}
