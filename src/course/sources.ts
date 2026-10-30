import { z } from "zod";

// The material an owner uploads to build a course from: documents as plain text, page by page, so
// generated content can cite "source, page" and a reader can check it. Text is extracted before it
// gets here (in the browser for PDFs); the core never parses files.

/**
 * What a document is for. Teaching material is what lessons are written from; past exams, tests and
 * briefs show what is being evaluated (what "mastery" means) but are never copied into the course.
 */
export const SOURCE_ROLES = ["material", "assessment", "brief"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Largest text a single page may hold; longer pages are cut when added. */
export const MAX_PAGE_CHARS = 20_000;

export const SourceSchema = z.strictObject({
  /** Stable id, e.g. "s1". Citations use it. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The file name the owner uploaded, e.g. "ComPar-Lec03.pdf". */
  name: z.string().min(1).max(200),
  /** Absent until the owner or the generator classifies it. */
  role: z.enum(SOURCE_ROLES).optional(),
  /** Page texts in order; page n (1-based) is pages[n - 1]. A Markdown or text file is one page. */
  pages: z.array(z.string().max(MAX_PAGE_CHARS)).min(1),
});
export type Source = z.infer<typeof SourceSchema>;

/** The text of a cited page, or undefined if the citation doesn't point at one. */
export function citedPage(sources: readonly Source[], citation: { source: string; page: number }): string | undefined {
  return sources.find((s) => s.id === citation.source)?.pages[citation.page - 1];
}
