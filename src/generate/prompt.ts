import { slugify } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import type { Audience } from "./types.js";

// Prompt assembly for generation calls: fixed parts are kept whole, elastic parts (page text, long
// lists) are shortened so that every call fits its character budget whatever the input size.

export interface Part {
  text: string;
  /** May be shortened to fit. */
  elastic?: boolean;
  /** Kept whole around an elastic text, e.g. the tags around a page. */
  before?: string;
  after?: string;
}

const SEPARATOR = "\n\n";

/**
 * Joins parts in order, shortening elastic ones so the result is at most `budget` characters.
 * Short elastic parts keep their full text; the room they don't use goes to the longer ones.
 */
export function fitParts(parts: readonly Part[], budget: number): string {
  const fixed = parts.reduce((n, p) => n + (p.elastic ? (p.before ?? "").length + (p.after ?? "").length : p.text.length), 0);
  let room = Math.max(0, budget - fixed - SEPARATOR.length * Math.max(0, parts.length - 1));

  const allowed = new Map<number, number>();
  const elastic = parts.flatMap((p, i) => (p.elastic ? [i] : [])).sort((a, b) => parts[a]!.text.length - parts[b]!.text.length);
  elastic.forEach((index, k) => {
    const share = Math.floor(room / (elastic.length - k));
    const take = Math.min(parts[index]!.text.length, share);
    allowed.set(index, take);
    room -= take;
  });

  return parts
    .map((p, i) => {
      if (!p.elastic) return p.text;
      const limit = allowed.get(i)!;
      const text = p.text.length <= limit ? p.text : limit > 0 ? `${p.text.slice(0, limit - 1)}…` : "";
      return (p.before ?? "") + text + (p.after ?? "");
    })
    .join(SEPARATOR);
}

/**
 * Keeps lines spread evenly over the list until they fit `budget`, so a long input is sampled across
 * every source instead of losing its end. Returns the kept lines and how many were dropped.
 */
export function thinLines(lines: readonly string[], budget: number): { lines: string[]; dropped: number } {
  const total = lines.reduce((n, line) => n + line.length + 1, 0);
  if (total <= budget) return { lines: [...lines], dropped: 0 };
  const keep = Math.max(1, Math.floor((lines.length * budget) / total));
  for (let n = keep; n >= 1; n--) {
    const step = lines.length / n;
    const kept = Array.from({ length: n }, (_, i) => lines[Math.floor(i * step)]!);
    if (kept.reduce((sum, line) => sum + line.length + 1, 0) <= budget) return { lines: kept, dropped: lines.length - n };
  }
  return { lines: [], dropped: lines.length };
}

export const pageLabel = (c: Citation) => `${c.source} p.${c.page}`;

/** An id from a model-written title: a slug, cut at `max` characters, made unique against `taken`. */
export function uniqueSlug(text: string, fallback: string, taken: Set<string>, max = 40): string {
  const base = slugify(text).slice(0, max).replace(/-+$/, "") || fallback;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Language instruction shared by the writing agents. */
export const languageLine = (language: string | undefined) =>
  language ? `Write in ${language}.` : "Write in the language of the source pages.";

const AUDIENCE_LINES: Record<Audience, string> = {
  beginner:
    "Audience: new to the topic. Define every term the first time it is used, go in small steps, and give a worked example wherever a procedure is taught. Questions check the core ideas, not tricks.",
  intermediate:
    "Audience: some background. Recap basics in a sentence at most and spend the words on reasoning: why things work, when to use which, and the trade-offs.",
  advanced:
    "Audience: advanced. Be concise and start from problems; skip the basics and spend the words on subtle points, edge cases and trade-offs.",
};

/** Audience instruction shared by the planner, writer and examiner; empty when the owner gave none. */
export const audienceLine = (audience: Audience | undefined) => (audience ? AUDIENCE_LINES[audience] : "");

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
