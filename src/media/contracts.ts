import type { Citation } from "../course/schema.js";

/** One rendered page of an uploaded file. */
export interface PageImage {
  mime: "image/png" | "image/jpeg";
  base64: string;
}

/**
 * Where the tutor gets a source page as a picture. Stream A implements it (the pages it stored in the
 * build); until the join the tutor runs on `noPageImages` and falls back to the page's text.
 */
export interface PageImages {
  get(sourceId: string, page: number): Promise<PageImage | null>;
}
export const noPageImages: PageImages = { get: async () => null };

/**
 * Pictures inside lesson Markdown are written `![caption](fig:s1/p15/f1)` (a figure cropped from a source
 * page; stream A) or `![caption](gen:3fa9c1d2)` (an image generated for one learner; stream B). Anything
 * else is dropped to its alt text, as the sanitiser does today.
 */
export const ASSET_REF = /^(fig|gen):[a-z0-9][a-z0-9/_-]{0,79}$/;
export type AssetKind = "fig" | "gen";

export function parseAssetRef(src: string): { kind: AssetKind; id: string } | null {
  const match = /^(fig|gen):(.+)$/.exec(src);
  return match && ASSET_REF.test(src) ? { kind: match[1] as AssetKind, id: match[2]! } : null;
}

/** Why a block is on the page. Stream A draws the chip; stream B fills it in for personal blocks. */
export interface Provenance {
  pages: Citation[];
  fact_check: "supported" | "doubted" | "unchecked";
  /** "Made for you because…": only on personal blocks. */
  made_for?: string;
}

/** What the tutor asks the page to do. The browser performs it; the server only names it. */
export type TutorAction =
  | { kind: "go_to_section"; lesson: string; section: string }
  | { kind: "open_source"; source: string; page: number };
