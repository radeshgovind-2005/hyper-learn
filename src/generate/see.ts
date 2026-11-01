import type { PageImage } from "../media/contracts.js";
import type { FigureRead } from "../meta/vision.js";
import type { Box, Figure } from "../storage/media.js";
import { CallBudgetExceeded, type ModelCalls } from "./models.js";
import { mapLimit } from "./prompt.js";

// Step 2b, "see": the build looks at the pictures of pages that have figures, not only their text. Vision
// says what each figure is and roughly where; SAM finds its exact outline; code picks the box and assigns
// the id (`s1/p15/f1`). Figures are shared by every learner and made once per build. A failed call costs
// that page its figures, never the build: the course is then written from the page's text, as before.

/** What the build is given to look at pages with. Injected, so tests run on scripted fakes. */
export interface PageSeer {
  /** Pages that have a picture (uploaded by the browser), any source. */
  pages: readonly { source: string; page: number }[];
  image(source: string, page: number): Promise<PageImage | null>;
  /** Spark vision on one page image. */
  read(image: PageImage): Promise<FigureRead[]>;
  /** SAM on one page image; absent, or failing, leaves vision's box. */
  segment?(image: PageImage, prompt: string): Promise<Box[]>;
}

/** Below this overlap a SAM box is about something else on the page. */
const MIN_IOU = 0.3;

const area = (b: Box) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

export function iou(a: Box, b: Box): number {
  const inter = area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) });
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Vision's box, put in order and inside the page; the whole page if it is missing or empty. */
export function cleanBox(box: Box | null | undefined): Box {
  if (!box) return { x1: 0, y1: 0, x2: 1, y2: 1 };
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const [x1, x2] = [clamp(box.x1), clamp(box.x2)].sort((a, b) => a - b) as [number, number];
  const [y1, y2] = [clamp(box.y1), clamp(box.y2)].sort((a, b) => a - b) as [number, number];
  return x2 - x1 < 0.02 || y2 - y1 < 0.02 ? { x1: 0, y1: 0, x2: 1, y2: 1 } : { x1, y1, x2, y2 };
}

/**
 * The crop: the SAM box that overlaps vision's the most (if it overlaps enough), joined with vision's
 * box so a title or legend SAM left out stays in; otherwise vision's box. A little margin around it.
 */
export function chooseBox(vision: Box, sam: readonly Box[]): Box {
  const best = sam.map((b) => ({ b, score: iou(vision, b) })).sort((x, y) => y.score - x.score)[0];
  const box = best && best.score >= MIN_IOU ? { x1: Math.min(vision.x1, best.b.x1), y1: Math.min(vision.y1, best.b.y1), x2: Math.max(vision.x2, best.b.x2), y2: Math.max(vision.y2, best.b.y2) } : vision;
  const pad = 0.01;
  return { x1: Math.max(0, box.x1 - pad), y1: Math.max(0, box.y1 - pad), x2: Math.min(1, box.x2 + pad), y2: Math.min(1, box.y2 + pad) };
}

const cut = (text: string | null | undefined, max: number) => (text ?? "").trim().slice(0, max);

export interface SeeResult {
  figures: Figure[];
  /** Pages read, vision calls and SAM calls made, for the build log. */
  pages: number;
  visionCalls: number;
  samCalls: number;
  /** Pages whose figures were lost to a failed call, with why. */
  failures: string[];
}

/**
 * Looks at every page `seer` has a picture of, among `sources` (the teaching material). Each vision and
 * SAM call is counted against the build's call budget; running out ends the build as any other call would.
 */
export async function seePages(sources: ReadonlySet<string>, seer: PageSeer, calls: ModelCalls, concurrency = 4): Promise<SeeResult> {
  const pages = seer.pages.filter((p) => sources.has(p.source));
  const result: SeeResult = { figures: [], pages: pages.length, visionCalls: 0, samCalls: 0, failures: [] };
  const perPage = await mapLimit(pages, concurrency, async ({ source, page }) => {
    const label = `${source} p.${page}`;
    let image: PageImage | null;
    let read: FigureRead[];
    try {
      image = await seer.image(source, page);
      if (!image) return [];
      calls.charge("vision");
      result.visionCalls++;
      read = await seer.read(image);
    } catch (error) {
      if (error instanceof CallBudgetExceeded) throw error;
      result.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const figures: Figure[] = [];
    for (const [i, f] of read.entries()) {
      const vision = cleanBox(f.box);
      let box = chooseBox(vision, []);
      if (seer.segment && f.sam_prompt.trim()) {
        try {
          calls.charge("segmentation");
          result.samCalls++;
          box = chooseBox(vision, await seer.segment(image, f.sam_prompt.trim()));
        } catch (error) {
          if (error instanceof CallBudgetExceeded) throw error;
          // Vision's box stands; the figure is kept.
        }
      }
      figures.push({
        id: `${source}/p${page}/f${i + 1}`,
        source,
        page,
        kind: f.kind,
        caption: cut(f.caption, 200) || `Figure on ${label}`,
        box,
        table_markdown: f.kind === "table" ? cut(f.table_markdown, 4_000) || null : null,
        latex: f.kind === "equation" ? cut(f.latex, 1_000) || null : null,
        teaches: cut(f.teaches, 300),
      });
    }
    return figures;
  });
  result.figures = perPage.flat();
  return result;
}

/** The figures on a set of pages, in page order. */
export function figuresOn(figures: readonly Figure[], pages: readonly { source: string; page: number }[]): Figure[] {
  return figures.filter((f) => pages.some((p) => p.source === f.source && p.page === f.page));
}
