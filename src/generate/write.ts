import { splitBlocks, type TextKind } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import type { Quote } from "../course/compile.js";
import { citedPage, type Source } from "../course/sources.js";
import { type CheckQuestion, CheckQuestionSchema } from "../interventions/templates.js";
import type { PlannedLesson, PlannedSection } from "./plan.js";
import { audienceLine, fitParts, languageLine, pageLabel, type Part } from "./prompt.js";
import type { SectionDraft } from "./schemas.js";
import type { BuildInput } from "./types.js";
import type { Figure } from "../storage/media.js";

// Step 4: each section is written from its planned pages only. Code checks that every block cites
// one of those pages, sanitizes the Markdown (the web app renders it as HTML), and turns the
// practice question into a check block whose options carry no misconception yet.

export interface WrittenBlock {
  kind: TextKind;
  markdown: string;
  cites: Citation[];
  /** The cited pages' words the block rests on, each found on its page. */
  quotes?: Quote[];
}

/** A text's words, lowercased and normalised, with where each starts and ends in it. */
export function wordsOf(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ word: m[0].normalize("NFKC").toLowerCase(), start: m.index!, end: m.index! + m[0].length }));
}

/**
 * Where `quote` is on `page`: its words in order, ignoring case, punctuation and spacing (PDF text breaks
 * lines and hyphenates where the model doesn't). Null if they aren't there. The viewer does the same.
 */
export function findQuote(page: string, quote: string): [number, number] | null {
  const want = wordsOf(quote).map((w) => w.word);
  if (want.length < 3) return null;
  const have = wordsOf(page);
  outer: for (let i = 0; i + want.length <= have.length; i++) {
    for (let k = 0; k < want.length; k++) if (have[i + k]!.word !== want[k]) continue outer;
    return [have[i]!.start, have[i + want.length - 1]!.end];
  }
  return null;
}

export interface WrittenSection {
  blocks: WrittenBlock[];
  check: CheckQuestion;
}

/** Which `fig:`/`gen:` pictures a block may keep; anything else becomes its alt text. */
export type AssetCheck = (ref: string) => boolean;

/** Inline code, and `$…$` / `$$…$$` formulas on one line (the same rule as the web app's extractMath). */
const KEPT_SPANS = /(`[^`\n]*`|\$\$[^$\n]+\$\$|(?<![\\$])\$(?=[^\s$])[^$\n]*?[^\s\\]\$(?!\d))/;

/** A formula as KaTeX reads it, with no `<` or `>` left for an HTML renderer to see. */
const cleanMath = (tex: string) => tex.replace(/</g, "\\lt ").replace(/>/g, "\\gt ");

/**
 * Inline code is left alone and formulas keep their TeX (with `<`, `>` as \lt, \gt); elsewhere images
 * become their alt text unless `asset` accepts their `fig:`/`gen:` ref, links keep only http(s) targets,
 * and `<` can't open a tag.
 */
const cleanInline = (text: string, asset: AssetCheck) =>
  text
    .split(KEPT_SPANS)
    .map((part, i) =>
      i % 2 === 1
        ? part.startsWith("`")
          ? part
          : cleanMath(part)
        : part
            .replace(/!\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (_image, alt: string, ref: string) => (asset(ref) ? `![${alt.replace(/[[\]]/g, "")}](${ref})` : alt))
            .replace(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (link: string, label: string, url: string) => (/^https?:\/\//i.test(url) ? link : label))
            .replace(/</g, "&lt;"),
    )
    .join("");

const NO_ASSETS: AssetCheck = () => false;

/**
 * Generated Markdown as the app may render it: headings become bold lines (a `## ` line would start a
 * new section when the lesson is rendered), no raw HTML, links only to http(s), and pictures only where
 * `asset` accepts their `fig:`/`gen:` ref. Fenced code is kept as written; an unclosed fence is closed.
 * Tables are ordinary lines and pass through; `$$` lines open and close a display formula, kept as TeX.
 */
export function sanitizeMarkdown(markdown: string, asset: AssetCheck = NO_ASSETS): string {
  const out: string[] = [];
  let inFence = false;
  let inMath = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (!inMath && line.trimStart().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else if (line.trim() === "$$") {
      inMath = !inMath;
      out.push("$$");
    } else if (inMath) {
      out.push(cleanMath(line));
    } else {
      out.push(cleanInline(line.replace(/^\s{0,3}#{1,6}\s+(.+?)[\s#]*$/, "**$1**"), asset));
    }
  }
  if (inFence) out.push("```");
  if (inMath) out.push("$$");
  return out.join("\n").trim();
}

export interface WriterContext {
  input: BuildInput;
  sources: readonly Source[];
  lesson: PlannedLesson;
  section: PlannedSection;
  /** Figures on the section's pages (the "see" step); the writer may show these and no others. */
  figures?: readonly Figure[];
}

/** What vision read from a page's picture that its text loses: tables as Markdown, equations as LaTeX. */
function readFromPicture(figures: readonly Figure[]): string {
  const parts = figures.flatMap((f) => (f.table_markdown ? [`${f.caption}:\n${f.table_markdown}`] : f.latex ? [`${f.caption}: $$ ${f.latex} $$`] : []));
  return parts.length > 0 ? `\n\nRead from the page's picture:\n${parts.join("\n\n")}` : "";
}

/** The writer's user message: the section's place in the lesson, its objectives, and its pages (shortened to fit). */
export function writerPrompt({ input, sources, lesson, section, figures = [] }: WriterContext, room: number, retry?: string): string {
  const objectives = lesson.objectives.filter((o) => o.sections.includes(section.id)).map((o) => `- ${o.statement}`);
  const others = lesson.sections.filter((s) => s.id !== section.id).map((s) => `"${s.title}"`);
  const header = [
    `Course: ${input.title}`,
    `Lesson: ${lesson.title}. ${lesson.summary}`,
    others.length > 0 && `Other sections of this lesson (leave their topics to them): ${others.join(", ")}`,
    `Write the section "${section.title}".`,
    objectives.length > 0 && `It teaches:\n${objectives.join("\n")}`,
    languageLine(input.language),
    audienceLine(input.audience),
    `Cite only these pages: ${section.pages.map(pageLabel).join(", ")}.`,
    figures.length > 0 &&
      `Figures on these pages. Where one helps, show it on a line of its own as ![caption](fig:ID), and cite its page; use no other ids:\n${figures
        .map((f) => `- fig:${f.id} (${f.kind}, ${f.source} p.${f.page}): ${f.caption}${f.teaches ? ` It shows: ${f.teaches}` : ""}`)
        .join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const pages: Part[] = section.pages.map((ref) => ({
    text: (citedPage(sources, ref) ?? "") + readFromPicture(figures.filter((f) => f.source === ref.source && f.page === ref.page)),
    elastic: true,
    before: `<source id="${ref.source}" page="${ref.page}">\n`,
    after: "\n</source>",
  }));
  return fitParts([{ text: header }, ...pages, ...(retry ? [{ text: retry }] : [])], room);
}

const FIGURE_REF = /!\[[^\]]*\]\(\s*((?:fig|gen):[^)\s]*)/g;

/**
 * Checks a section draft against its planned pages and builds the section, or lists what to fix. A
 * picture must be one of `figures` (those on the section's pages); any other id is sent back.
 */
export function sectionFromDraft(
  draft: SectionDraft,
  section: PlannedSection,
  figures: readonly Figure[] = [],
  sources?: readonly Source[],
): { section?: WrittenSection; problems: string[]; dropped_quotes?: number } {
  const problems: string[] = [];
  const allowed = section.pages.map(pageLabel);
  const blocks: WrittenBlock[] = [];
  const shown = new Set(figures.map((f) => `fig:${f.id}`));
  let dropped = 0;
  const ids = figures.map((f) => `fig:${f.id}`).join(", ") || "none";

  draft.blocks.forEach((block, i) => {
    for (const [, ref] of block.markdown.matchAll(FIGURE_REF)) {
      if (!shown.has(ref!)) problems.push(`block ${i + 1} shows ${ref}, which is not a figure on this section's pages (you may use: ${ids})`);
    }
    const markdown = sanitizeMarkdown(block.markdown, (ref) => shown.has(ref));
    if (!markdown) return;
    const cites: Citation[] = [];
    for (const ref of block.cites) {
      if (!allowed.includes(pageLabel(ref))) problems.push(`block ${i + 1} cites ${pageLabel(ref)}, which is not one of this section's pages (${allowed.join(", ")})`);
      else if (!cites.some((c) => pageLabel(c) === pageLabel(ref))) cites.push({ source: ref.source, page: ref.page });
    }
    if (block.cites.length === 0) problems.push(`block ${i + 1} cites no page; every block must cite the pages it is based on`);
    // A quote is kept only if it is on the page it names; one that isn't is dropped, not fatal (PDF text is noisy).
    const quotes: Quote[] = [];
    for (const ref of block.cites) {
      const text = ref.quote?.trim();
      if (!text || !sources || !cites.some((c) => pageLabel(c) === pageLabel(ref))) continue;
      const page = citedPage(sources, ref);
      if (page !== undefined && findQuote(page, text)) quotes.push({ source: ref.source, page: ref.page, text: text.slice(0, 300) });
      else dropped++;
    }
    for (const part of splitBlocks(markdown)) blocks.push({ ...part, cites, ...(quotes.length > 0 && { quotes }) });
  });
  if (blocks.length === 0) problems.push("the section has no text blocks");

  const options = draft.check.options.map((o) => ({ text: o.text.trim(), correct: o.correct, misconception: null, feedback: o.feedback.trim() }));
  const correct = options.filter((o) => o.correct).length;
  if (correct !== 1) problems.push(`the practice question must have exactly one correct option (has ${correct})`);
  const check = CheckQuestionSchema.safeParse({ prompt: draft.check.prompt.trim(), options });
  if (!check.success) {
    for (const issue of check.error.issues) problems.push(`practice question ${issue.path.join(".") || "(whole)"}: ${issue.message}`);
  }

  return problems.length > 0 || !check.success ? { problems } : { section: { blocks, check: check.data }, problems, ...(dropped > 0 && { dropped_quotes: dropped }) };
}

/** The section's text with its citations, for the fact checker. */
export function sectionText(written: WrittenSection): string {
  return written.blocks.map((b, i) => `[${i + 1}] (cites ${b.cites.map(pageLabel).join(", ")})\n${b.markdown}`).join("\n\n");
}
