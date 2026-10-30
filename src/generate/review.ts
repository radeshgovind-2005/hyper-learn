import { citedPage, type Source } from "../course/sources.js";
import type { PlannedLesson, PlannedSection } from "./plan.js";
import { fitParts, type Part } from "./prompt.js";
import { sectionText, type WrittenSection } from "./write.js";

// Step 7, model half: code already guarantees every block cites a real page of its section (write.ts,
// checks.ts). The fact checker reads the section next to those pages and lists claims they don't support.

export function factCheckPrompt(sources: readonly Source[], lesson: PlannedLesson, section: PlannedSection, written: WrittenSection, room: number): string {
  const cited = section.pages.filter((ref) => written.blocks.some((b) => b.cites.some((c) => c.source === ref.source && c.page === ref.page)));
  const pages: Part[] = cited.map((ref) => ({
    text: citedPage(sources, ref) ?? "",
    elastic: true,
    before: `<source id="${ref.source}" page="${ref.page}">\n`,
    after: "\n</source>",
  }));
  return fitParts(
    [
      { text: `Section "${section.title}" of the lesson "${lesson.title}". Each block lists the pages it cites.` },
      { text: sectionText(written), elastic: true, before: "<section>\n", after: "\n</section>" },
      ...pages,
      { text: "Which claims in the section are not supported by the pages they cite?" },
    ],
    room,
  );
}
