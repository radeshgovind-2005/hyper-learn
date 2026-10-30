// Turns a dropped file into page texts, the shape a course source is stored in (src/course/sources.ts).
// PDFs are read here, in the browser, so citations can point at real page numbers; pdf.js loads only
// when the first PDF arrives. Text files are one page, split only if longer than a page may be.

/** The server cuts pages at this length (MAX_PAGE_CHARS); longer text files are split before it does. */
const PAGE_CHARS = 20_000;
/** What one addSource/appendPages message may carry (SOURCE_LIMITS.charsPerCall), with room for the JSON around it. */
export const CHARS_PER_CALL = 450_000;

export const ACCEPTED = ".pdf,.md,.markdown,.txt";

export interface ReadFile {
  name: string;
  pages: string[];
}

async function pdfPages(file: File, onProgress?: (page: number, of: number) => void): Promise<string[]> {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    onProgress?.(n, pdf.numPages);
  }
  await task.destroy();
  return pages;
}

/** Splits long text at paragraph breaks into pages of at most PAGE_CHARS. */
function textPages(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const next = page ? `${page}\n\n${paragraph}` : paragraph;
    if (next.length <= PAGE_CHARS) page = next;
    else {
      if (page) pages.push(page);
      // A single paragraph longer than a page is cut where it must be.
      for (let i = 0; i < paragraph.length; i += PAGE_CHARS) pages.push(paragraph.slice(i, i + PAGE_CHARS));
      page = pages.pop() ?? "";
    }
  }
  if (page.trim()) pages.push(page);
  return pages;
}

export async function readFile(file: File, onProgress?: (page: number, of: number) => void): Promise<ReadFile> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pages = await pdfPages(file, onProgress);
    if (pages.every((p) => !p)) throw new Error(`${file.name} has no text to read (a scanned PDF?)`);
    return { name: file.name, pages: pages.map((p) => p || "(no text on this page)") };
  }
  if (/\.(md|markdown|txt)$/.test(lower)) {
    const pages = textPages((await file.text()).trim());
    if (pages.length === 0) throw new Error(`${file.name} is empty`);
    return { name: file.name, pages };
  }
  throw new Error(`${file.name}: only PDF, Markdown and text files can be added`);
}

/** Groups pages into messages under CHARS_PER_CALL each: the first goes to addSource, the rest to appendPages. */
export function chunkPages(pages: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const page of pages) {
    if (current.length > 0 && size + page.length > CHARS_PER_CALL) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += page.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
