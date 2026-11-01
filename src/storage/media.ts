import type { Sql } from "./sql.js";

// What a studio course keeps of its uploaded files besides their text: the original file (so the real
// page can be shown), pictures of the pages that have figures, and the figures the build found on them.
// All of it grows per file (sources are capped at 30) and is written once, at upload or in the build;
// learners only read it. Bytes are stored as base64 text: they arrive and leave as base64, and the
// Worker never needs the raw bytes, so nothing is decoded or encoded on the way through.

/** Limits on stored media, checked on the server. Sizes are decoded bytes. */
export const MEDIA_LIMITS = {
  /** One chunk of an original file: 512 KB is ~683 KB as base64, under the 1 MiB WebSocket message limit. */
  chunkBytes: 512 * 1024,
  fileBytes: 25 * 1024 * 1024,
  courseFileBytes: 100 * 1024 * 1024,
  pageImageBytes: 150 * 1024,
  pageImages: 300,
} as const;

/** The original file's shape, without its bytes. Complete when every chunk 0…total-1 is stored. */
export interface StoredFile {
  size: number;
  chunks: number;
  total: number;
}

export interface FileChunk {
  seq: number;
  total: number;
  base64: string;
}

/** A box on a page image, in pixels of that image. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const FIGURE_KINDS = ["figure", "table", "chart", "equation"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** A figure the build found on a page: where it is on the page image, and what vision read from it. */
export interface Figure {
  /** `s1/p15/f1`: assigned by code, never by a model. */
  id: string;
  source: string;
  page: number;
  kind: FigureKind;
  caption: string;
  box: Box;
  table_markdown: string | null;
  latex: string | null;
  teaches: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The number of bytes a base64 string decodes to, or null if it isn't base64. Checked without decoding. */
export function base64Size(text: string): number | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

export class SqlMedia {
  constructor(private readonly sql: Sql) {
    // The primary keys are the indexes every read uses: (source, seq), (source, page), figure id.
    sql`CREATE TABLE IF NOT EXISTS hl_source_files (
      source_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      total INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (source_id, seq)
    )`;
    sql`CREATE TABLE IF NOT EXISTS hl_page_images (
      source_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (source_id, page)
    )`;
    sql`CREATE TABLE IF NOT EXISTS hl_figures (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      data TEXT NOT NULL
    )`;
    sql`CREATE INDEX IF NOT EXISTS hl_figures_page ON hl_figures (source_id, page)`;
  }

  // ─── Original files ───────────────────────────────────────────────

  /**
   * Stores one chunk. Idempotent per (source, seq): sending it again replaces it. `total` is the file's
   * chunk count; chunks at or past it (left from an earlier, longer upload of the same source) are dropped.
   */
  putChunk(source: string, seq: number, total: number, base64: string, bytes: number) {
    this.sql`DELETE FROM hl_source_files WHERE source_id = ${source} AND seq >= ${total}`;
    this.sql`INSERT INTO hl_source_files (source_id, seq, total, bytes, data) VALUES (${source}, ${seq}, ${total}, ${bytes}, ${base64})
      ON CONFLICT (source_id, seq) DO UPDATE SET total = excluded.total, bytes = excluded.bytes, data = excluded.data`;
  }

  chunk(source: string, seq: number): FileChunk | undefined {
    const [row] = this.sql<{ total: number; data: string }>`SELECT total, data FROM hl_source_files WHERE source_id = ${source} AND seq = ${seq}`;
    return row && { seq, total: row.total, base64: row.data };
  }

  /** Bytes stored for a source, not counting chunk `except` (the one about to be replaced). */
  fileBytes(source: string, except = -1): number {
    return (this.sql<{ n: number }>`SELECT COALESCE(SUM(bytes), 0) AS n FROM hl_source_files WHERE source_id = ${source} AND seq != ${except}`[0] as { n: number }).n;
  }

  /** Bytes of every original file in the course, not counting one chunk about to be replaced. */
  courseFileBytes(except?: { source: string; seq: number }): number {
    const source = except?.source ?? "";
    const seq = except?.seq ?? -1;
    return (this.sql<{ n: number }>`SELECT COALESCE(SUM(bytes), 0) AS n FROM hl_source_files WHERE NOT (source_id = ${source} AND seq = ${seq})`[0] as { n: number }).n;
  }

  /** Every source's stored file, by source id: one grouped query over at most 30 sources. */
  files(): Map<string, StoredFile> {
    const rows = this.sql<{ source_id: string; size: number; chunks: number; total: number }>`
      SELECT source_id, SUM(bytes) AS size, COUNT(*) AS chunks, MAX(total) AS total FROM hl_source_files GROUP BY source_id`;
    return new Map(rows.map((r) => [r.source_id, { size: r.size, chunks: r.chunks, total: r.total }]));
  }

  file(source: string): StoredFile | undefined {
    const [row] = this.sql<{ size: number | null; chunks: number; total: number | null }>`
      SELECT SUM(bytes) AS size, COUNT(*) AS chunks, MAX(total) AS total FROM hl_source_files WHERE source_id = ${source}`;
    return row && row.chunks > 0 ? { size: row.size ?? 0, chunks: row.chunks, total: row.total ?? 0 } : undefined;
  }

  // ─── Page images ──────────────────────────────────────────────────

  putPageImage(source: string, page: number, mime: string, base64: string, bytes: number) {
    this.sql`INSERT INTO hl_page_images (source_id, page, mime, bytes, data) VALUES (${source}, ${page}, ${mime}, ${bytes}, ${base64})
      ON CONFLICT (source_id, page) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, data = excluded.data`;
  }

  pageImage(source: string, page: number): { mime: string; base64: string } | undefined {
    const [row] = this.sql<{ mime: string; data: string }>`SELECT mime, data FROM hl_page_images WHERE source_id = ${source} AND page = ${page}`;
    return row && { mime: row.mime, base64: row.data };
  }

  hasPageImage(source: string, page: number): boolean {
    return this.sql`SELECT 1 FROM hl_page_images WHERE source_id = ${source} AND page = ${page}`.length > 0;
  }

  pageImageCount(): number {
    return (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_page_images`[0] as { n: number }).n;
  }

  /** Which pages have a picture, per source: (source, page) pairs only, never the bytes. */
  pagesWithImages(): { source: string; page: number }[] {
    return this.sql<{ source: string; page: number }>`SELECT source_id AS source, page FROM hl_page_images ORDER BY source_id, page`.map((r) => ({ ...r }));
  }

  // ─── Figures ──────────────────────────────────────────────────────

  /** Replaces every figure of a page: a rebuild reads the page again. */
  setFigures(source: string, page: number, figures: readonly Figure[]) {
    this.sql`DELETE FROM hl_figures WHERE source_id = ${source} AND page = ${page}`;
    for (const figure of figures) {
      this.sql`INSERT INTO hl_figures (id, source_id, page, data) VALUES (${figure.id}, ${source}, ${page}, ${JSON.stringify(figure)})`;
    }
  }

  figure(id: string): Figure | undefined {
    const [row] = this.sql<{ data: string }>`SELECT data FROM hl_figures WHERE id = ${id}`;
    return row && (JSON.parse(row.data) as Figure);
  }

  /** The figures of some pages (a section's cited pages): one query per page, a handful per section. */
  figuresOn(source: string, page: number): Figure[] {
    return this.sql<{ data: string }>`SELECT data FROM hl_figures WHERE source_id = ${source} AND page = ${page} ORDER BY id`.map((r) => JSON.parse(r.data) as Figure);
  }

  // ─── Removal ──────────────────────────────────────────────────────

  /** Everything stored for a source, when it is removed. */
  removeSource(source: string) {
    this.sql`DELETE FROM hl_source_files WHERE source_id = ${source}`;
    this.sql`DELETE FROM hl_page_images WHERE source_id = ${source}`;
    this.sql`DELETE FROM hl_figures WHERE source_id = ${source}`;
  }
}
