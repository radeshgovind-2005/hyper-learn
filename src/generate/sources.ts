import type { Source, SourceRole } from "../course/sources.js";
import { copiedSentence, sentencesOf } from "./checks.js";
import type { BuilderModels, ModelCalls } from "./models.js";
import { fitParts } from "./prompt.js";

// Steps 1 and 2: what each source is for, and what is in it. A source's role decides how it is used:
// teaching material is written from and cited; assessments and briefs only show what is evaluated.

/** Matches whole words of a file name ("test" in "exam-test.pdf", not in "latest.pdf"); digits may follow. */
const words = (pattern: string) => new RegExp(`(?:^|[^a-z])(?:${pattern})(?=[^a-z]|$)`, "i");

/** File-name hints, checked in this order: "exam-review-notes" is still an exam. */
const ROLE_HINTS: ReadonlyArray<readonly [SourceRole, RegExp]> = [
  ["assessment", words("exams?|tests?|quiz(zes)?|midterms?|finals?|past[-_ ]?papers?|assessments?|exercises?|problem[-_ ]?sets?|tentamen|klausur|examen|pr[uü]fung")],
  ["brief", words("brief|projects?|assignments?|spec|specification|requirements|rubric")],
  ["material", words("lectures?|lec|chapters?|ch|notes|slides|book|reading|week|handout|unit|module|tutorial")],
];

/** The role a file name suggests, if any. */
export function roleFromName(name: string): SourceRole | undefined {
  return ROLE_HINTS.find(([, pattern]) => pattern.test(name))?.[0];
}

const CLASSIFY_SAMPLE = 3_000;

export interface Classified {
  source: Source & { role: SourceRole };
  how: "owner" | "file name" | "model";
}

/** The owner's role wins; then a file-name hint; a model reads the start of the document only when neither says. */
export async function classifySource(source: Source, models: BuilderModels, calls: ModelCalls): Promise<Classified> {
  if (source.role) return { source: { ...source, role: source.role }, how: "owner" };
  const hinted = roleFromName(source.name);
  if (hinted) return { source: { ...source, role: hinted }, how: "file name" };

  const sample = source.pages.join("\n").slice(0, CLASSIFY_SAMPLE);
  const prompt = fitParts(
    [
      { text: `File name: ${source.name} (${source.pages.length} page${source.pages.length === 1 ? "" : "s"})` },
      { text: sample, elastic: true, before: `<document>\n`, after: "\n</document>" },
      { text: "Is this document material, an assessment or a brief?" },
    ],
    calls.room("classifier"),
  );
  const { role } = await calls.invoke(models.classifier, "classifier", prompt);
  return { source: { ...source, role }, how: "model" };
}

export interface DigestPoint {
  text: string;
  pages: number[];
}

export interface SourceDigest {
  source: Source & { role: SourceRole };
  points: DigestPoint[];
}

/** Groups consecutive pages into chunks of at most `room` characters of page text (a longer page is a chunk of its own). */
export function pageChunks(source: Source, room: number): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let size = 0;
  source.pages.forEach((text, i) => {
    const length = text.length + 20; // the <page> tags
    if (current.length > 0 && size + length > room) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(i + 1);
    size += length;
  });
  if (current.length > 0) chunks.push(current);
  return chunks.filter((chunk) => chunk.some((page) => source.pages[page - 1]!.trim() !== ""));
}

const TASK: Record<SourceRole, string> = {
  material: "This is teaching material. List its key ideas, definitions, procedures and worked examples, each with its page numbers.",
  assessment:
    "This is an assessment. List what it evaluates: the skills and concepts, the kinds of question (calculation, explanation, design, multiple choice…) and the level of detail expected, with page numbers. Describe; never copy question text.",
  brief:
    "This is a project or assignment brief. List what learners must be able to do to deliver it: skills, concepts and requirements, with page numbers. Describe; never copy the text.",
};

/** Step 2 for one source: one call per chunk of pages, points kept only with pages that were in the chunk. */
export async function digestSource(
  source: Source & { role: SourceRole },
  models: BuilderModels,
  calls: ModelCalls,
): Promise<{ digest: SourceDigest; calls: number; copied: number }> {
  const header = `Source ${source.id} "${source.name}".\n${TASK[source.role]}`;
  const room = calls.room("digester") - header.length - 200;
  const points: DigestPoint[] = [];
  const chunks = pageChunks(source, room);
  // What an assessment or brief evaluates is passed on; its wording is not, even if the digester copies it.
  const own = source.role === "material" ? [] : sentencesOf(source);
  let copied = 0;
  for (const chunk of chunks) {
    const pages = chunk.map((page) => ({
      text: source.pages[page - 1]!,
      elastic: true,
      before: `<page n="${page}">\n`,
      after: "\n</page>",
    }));
    const draft = await calls.invoke(models.digester, "digester", fitParts([{ text: header }, ...pages], calls.room("digester")));
    for (const point of draft.points) {
      const text = point.text.trim();
      const valid = [...new Set(point.pages.filter((page) => chunk.includes(page)))];
      // A material point must say where it comes from, or nothing can be written from it.
      if (!text || (valid.length === 0 && source.role === "material")) continue;
      if (copiedSentence(text, own)) copied++;
      else points.push({ text, pages: valid });
    }
  }
  return { digest: { source, points }, calls: chunks.length, copied };
}
