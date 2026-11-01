// Finds the part of a source page a lesson block is based on, so the viewer can highlight it. A plain
// heuristic, not a citation check: the page is cut into lines (long lines into sentences), each piece
// is scored by the longer words it shares with the block, and the best piece is highlighted together
// with up to two neighbours that score nearly as well.

/** Lowercase words of 4+ letters: short ones ("the", "and") match everything. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

/** The page cut into pieces that join back into exactly the page text. */
export function pieces(text: string): string[] {
  return text.split(/(?<=\n)/).flatMap((line) => (line.length > 300 ? line.split(/(?<=[.!?])(?=\s)/) : [line]));
}

export interface Passage {
  pieces: string[];
  /** The highlighted pieces, [first, last] inclusive; null when nothing matches well enough. */
  marked: [number, number] | null;
}

/** The page's pieces and which of them best match `block` (Markdown is fine: only words count). */
export function findPassage(text: string, block: string | undefined): Passage {
  const parts = pieces(text);
  if (!block) return { pieces: parts, marked: null };
  const wanted = words(block);
  const scores = parts.map((p) => [...words(p)].filter((w) => wanted.has(w)).length);
  let best = 0;
  scores.forEach((score, i) => {
    if (score > scores[best]!) best = i;
  });
  // Two shared words at least, or any line would "match" on one common term.
  if ((scores[best] ?? 0) < 2) return { pieces: parts, marked: null };
  let [first, last] = [best, best];
  const close = (i: number) => (scores[i] ?? 0) >= Math.max(2, scores[best]! / 2);
  while (last - first < 2) {
    // Grow towards the better neighbour, while it scores nearly as well as the best piece.
    const before = first > 0 && close(first - 1) ? scores[first - 1]! : -1;
    const after = last < parts.length - 1 && close(last + 1) ? scores[last + 1]! : -1;
    if (before < 0 && after < 0) break;
    if (after >= before) last++;
    else first--;
  }
  return { pieces: parts, marked: [first, last] };
}

/** "ComPar-Lec01.pdf" → "ComPar-Lec01", cut to fit a chip. */
export function shortName(name: string, max = 28): string {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, "");
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

/** A piece of text on a rendered PDF page, as pdf.js gives it (getTextContent). */
export interface TextItem {
  str: string;
  hasEOL?: boolean;
}

/**
 * The text items of a PDF page that hold the passage best matching `block`, by index: the page's text is
 * joined from its items the way the upload extracts it (an item, then a line break where the item ends a
 * line), findPassage picks the pieces, and every item that overlaps them is marked.
 */
export function markItems(items: readonly TextItem[], block: string | undefined): number[] {
  let text = "";
  const spans = items.map((item) => {
    const start = text.length;
    text += item.str + (item.hasEOL ? "\n" : "");
    return [start, start + item.str.length] as const;
  });
  const { pieces: parts, marked } = findPassage(text, block);
  if (!marked) return [];
  const from = parts.slice(0, marked[0]).join("").length;
  const to = from + parts.slice(marked[0], marked[1] + 1).join("").length;
  return spans.flatMap(([start, end], i) => (end > start && start < to && end > from ? [i] : []));
}
