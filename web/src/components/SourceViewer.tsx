import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem as PdfTextItem } from "pdfjs-dist/types/src/display/api.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchOriginal, loadPdfjs } from "../files.js";
import { findPassage, markItems } from "../passage.js";
import type { Call, CitedSource, Figure, SourcePage } from "../types.js";
import "../styles/viewer.css";

/** A source page to open: from a lesson's citation chip, or from the studio's file list. */
export interface SourceTarget {
  source: CitedSource;
  page: number;
  /** The lesson text the reader came from: the page's best match for it is highlighted. */
  passage?: string;
  /** The owner's view (any file, any page) instead of a learner's (only files lessons cite). */
  owner: boolean;
}

const ZOOMS = [1, 1.5, 2] as const;

/** One parsed PDF per source and reader, kept for the page's life: paging and reopening don't fetch it again. */
const documents = new Map<string, Promise<PDFDocumentProxy>>();
function openDocument(call: Call, owner: boolean, source: CitedSource): Promise<PDFDocumentProxy> {
  const method = owner ? "ownerSourceFileChunk" : "sourceFileChunk";
  const key = `${method}:${source.id}:${source.file!.total}`;
  let pending = documents.get(key);
  if (!pending) {
    pending = (async () => {
      const [pdfjs, bytes] = await Promise.all([loadPdfjs(), fetchOriginal(call, method, source.id, source.file!.total)]);
      // pdf.js may take over the buffer it is given; the cached bytes stay usable.
      return pdfjs.getDocument({ data: bytes.slice() }).promise;
    })();
    pending.catch(() => documents.delete(key));
    documents.set(key, pending);
  }
  return pending;
}

interface Mark {
  left: number;
  top: number;
  width: number;
  height: number;
  /** A figure's outline rather than highlighted text. */
  box?: boolean;
}

/** The figure a block that is only a picture shows (`![…](fig:s1/p15/f1)`): the viewer outlines it on the page. */
const FIGURE_BLOCK = /^\s*!\[[^\]]*\]\(fig:([a-z0-9][a-z0-9/_-]{0,79})\)\s*$/;

/** The real page on a canvas, with the cited lines marked in yellow over it. */
function PdfPage({ call, target, page, zoom, onError }: { call: Call; target: SourceTarget; page: number; zoom: number; onError: (message: string) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const firstMark = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width === 0) return;
    let current = true;
    let task: { cancel: () => void } | undefined;
    setLoading(true);
    void (async () => {
      try {
        const pdf = await openDocument(call, target.owner, target.source);
        const pdfPage = await pdf.getPage(page);
        const scale = (width * zoom) / pdfPage.getViewport({ scale: 1 }).width;
        const viewport = pdfPage.getViewport({ scale });
        const el = canvas.current;
        if (!current || !el) return;
        const ratio = window.devicePixelRatio || 1;
        el.width = Math.floor(viewport.width * ratio);
        el.height = Math.floor(viewport.height * ratio);
        const render = pdfPage.render({ canvas: el, viewport, ...(ratio !== 1 && { transform: [ratio, 0, 0, ratio, 0, 0] }) });
        task = render;
        // Only the cited page is marked: on the others a match would be a guess about a different passage.
        const figureId = page === target.page ? FIGURE_BLOCK.exec(target.passage ?? "")?.[1] : undefined;
        const content = page === target.page && target.passage && !figureId ? await pdfPage.getTextContent() : null;
        const figure = figureId ? await call<Figure>("figure", [figureId]).catch(() => null) : null;
        await render.promise;
        if (!current) return;
        setSize({ width: viewport.width, height: viewport.height });
        if (figure && figure.source === target.source.id && figure.page === page) {
          // A figure's box is in fractions of its page picture, which has the page's shape.
          const { x1, y1, x2, y2 } = figure.box;
          setMarks([{ left: x1 * viewport.width, top: y1 * viewport.height, width: (x2 - x1) * viewport.width, height: (y2 - y1) * viewport.height, box: true }]);
          setLoading(false);
          return;
        }
        const pdfjs = await loadPdfjs();
        const items = (content?.items ?? []).filter((item): item is PdfTextItem => "str" in item);
        setMarks(
          markItems(items, target.passage).map((i) => {
            const item = items[i]!;
            const [, , c, d, x, y] = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
            const height = Math.hypot(c!, d!);
            return { left: x!, top: y! - height, width: item.width * scale, height: height * 1.15 };
          }),
        );
        setLoading(false);
      } catch (e) {
        if (current && !(e instanceof Error && e.name === "RenderingCancelledException")) onError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      current = false;
      task?.cancel();
    };
  }, [call, target, page, zoom, width, onError]);

  useEffect(() => {
    firstMark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [marks]);

  return (
    <div ref={frame} className="pdf-frame">
      <div className="pdf-page" style={size ? { width: size.width, height: size.height } : undefined}>
        <canvas ref={canvas} style={size ? { width: size.width, height: size.height } : undefined} aria-label={`Page ${page} of ${target.source.name}`} role="img" />
        {marks.map((m, i) => (
          <div key={i} ref={i === 0 ? firstMark : undefined} className={`pdf-mark ${m.box ? "box" : ""}`} style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />
        ))}
      </div>
      {loading && <div className="small muted pdf-loading">Loading the page…</div>}
    </div>
  );
}

/** The page's extracted text, with the best match marked: for files without their original, or by choice. */
function TextPage({ call, target, page }: { call: Call; target: SourceTarget; page: number }) {
  const [loaded, setLoaded] = useState<SourcePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mark = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    call<SourcePage>(target.owner ? "ownerSourcePage" : "sourcePage", [target.source.id, page])
      .then((p) => current && setLoaded(p))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [call, target.owner, target.source.id, page]);

  const shown = loaded?.page === page && loaded.source.id === target.source.id ? loaded : null;
  const passage = useMemo(() => (shown ? findPassage(shown.text, target.passage) : null), [shown, target.passage]);
  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [passage]);

  if (error) return <div className="notice">{error}</div>;
  if (!shown || !passage) return <div className="small muted">Loading the page…</div>;
  if (!shown.text.trim()) return <div className="small muted">This page has no text (it may be a picture or a scan).</div>;
  if (!passage.marked) return <div className="source-page">{shown.text}</div>;
  const [first, last] = passage.marked;
  return (
    <div className="source-page">
      {passage.pieces.slice(0, first).join("")}
      <mark ref={mark} className="source-mark">
        {passage.pieces.slice(first, last + 1).join("")}
      </mark>
      {passage.pieces.slice(last + 1).join("")}
    </div>
  );
}

/**
 * One page of an uploaded file, with paging: the real page when its original PDF was uploaded, its text
 * otherwise (or when the reader asks for the text). The server decides what may be read: learners get
 * the files their lessons cite (sourcePage, sourceFileChunk), owners every file.
 */
export function SourceViewer({ call, target }: { call: Call; target: SourceTarget }) {
  const [page, setPage] = useState(target.page);
  const file = target.source.file;
  const hasOriginal = Boolean(file && file.chunks === file.total);
  const [asText, setAsText] = useState(!hasOriginal);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const total = target.source.pages;
  const showPdf = hasOriginal && !asText && !pdfError;
  const highlighted = page === target.page && Boolean(target.passage);

  return (
    <div className="stack source-viewer">
      <div className="row between viewer-bar">
        <span className="small muted" aria-live="polite">
          Page {page} of {total}
        </span>
        <div className="row">
          {showPdf && (
            <div className="row zoom" role="group" aria-label="Zoom">
              {ZOOMS.map((z) => (
                <button key={z} className={`btn sm ${zoom === z ? "secondary" : "quiet"}`} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
                  {z === 1 ? "Fit" : `${z * 100}%`}
                </button>
              ))}
            </div>
          )}
          {hasOriginal && (
            <button className="btn quiet sm" aria-pressed={asText} onClick={() => setAsText((t) => !t)}>
              {asText ? "Page" : "Text"}
            </button>
          )}
          <button className="btn secondary sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button className="btn secondary sm" disabled={page >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
      {pdfError && <div className="notice">The original page couldn't be shown ({pdfError}), so this is its text.</div>}
      {showPdf ? <PdfPage call={call} target={target} page={page} zoom={zoom} onError={setPdfError} /> : <TextPage call={call} target={target} page={page} />}
      {highlighted && <p className="small muted">Highlighted: the words the lesson text you came from is based on.</p>}
      {!hasOriginal && target.owner && <p className="small muted">Add the original PDF in the studio's file list to see the page itself.</p>}
    </div>
  );
}
