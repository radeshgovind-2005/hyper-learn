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
  /** A PDF's own bytes, uploaded next to its text so the real page can be shown. */
  bytes?: Uint8Array;
}

/** pdf.js, loaded on first use, with its worker. */
export async function loadPdfjs() {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

async function pdfPages(data: Uint8Array, onProgress?: (page: number, of: number) => void): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data });
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdf.js may take over the buffer it is given, so it reads a copy.
    const pages = await pdfPages(bytes.slice(), onProgress);
    if (pages.every((p) => !p)) throw new Error(`${file.name} has no text to read (a scanned PDF?)`);
    return { name: file.name, pages: pages.map((p) => p || "(no text on this page)"), bytes };
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

// ─── The original file (stream A) ─────────────────────────────────────

/** Bytes per chunk of an original file (MEDIA_LIMITS.chunkBytes): ~683 KB as base64, under the 1 MiB message limit. */
export const FILE_CHUNK_BYTES = 512 * 1024;
/** The server's caps (MEDIA_LIMITS), checked here first so a big file fails before it uploads. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Call = <T>(method: string, args?: unknown[]) => Promise<T>;

/** Sends a PDF's bytes to the server in chunks, after its text (addSource), one message at a time. */
export async function uploadOriginal(call: Call, sourceId: string, bytes: Uint8Array, onProgress?: (sent: number, of: number) => void) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`The original is over ${MAX_FILE_BYTES / 1024 / 1024} MB, so only its text was added`);
  const total = Math.ceil(bytes.length / FILE_CHUNK_BYTES);
  for (let seq = 0; seq < total; seq++) {
    await call("addSourceFileChunk", [sourceId, seq, toBase64(bytes.subarray(seq * FILE_CHUNK_BYTES, (seq + 1) * FILE_CHUNK_BYTES)), total]);
    onProgress?.(seq + 1, total);
  }
}

/**
 * The original PDF of a source, fetched once per page load and kept in memory: every page of the viewer
 * and every figure reads the same copy. `method` is sourceFileChunk (learners) or ownerSourceFileChunk.
 */
const originals = new Map<string, Promise<Uint8Array>>();
export function fetchOriginal(call: Call, method: "sourceFileChunk" | "ownerSourceFileChunk", sourceId: string, total: number): Promise<Uint8Array> {
  const key = `${method}:${sourceId}:${total}`;
  let pending = originals.get(key);
  if (!pending) {
    pending = (async () => {
      const parts: Uint8Array[] = [];
      for (let seq = 0; seq < total; seq++) parts.push(fromBase64((await call<{ base64: string }>(method, [sourceId, seq])).base64));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    })();
    // A failed fetch is forgotten, so opening the viewer again retries it.
    pending.catch(() => originals.delete(key));
    originals.set(key, pending);
  }
  return pending;
}
