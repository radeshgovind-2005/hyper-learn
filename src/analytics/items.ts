import type { Grade } from "../assessment/grade.js";

// Item analysis from classical test theory: is each question a working instrument?
// A question that strong learners fail more often than weak ones (negative discrimination) is
// broken (a wrong key, an ambiguous prompt), and diagnosing the course from it would mislead.

/** Fewer graded responses than this and an item's statistics are not judged. */
export const MIN_ITEM_RESPONSES = 30;
/** Discrimination below this is weak; below 0 the item is excluded from diagnosis. */
export const MIN_DISCRIMINATION = 0.2;

export type ItemFlag = "ok" | "too_few_responses" | "weak_discrimination" | "negative_discrimination";

export interface ItemStats {
  item_id: string;
  responses: number;
  /** Mean score, 0–1 (the "p-value" of classical test theory: higher = easier). */
  difficulty: number;
  /** Point-biserial correlation of the item's score with the rest of the quiz (corrected item-total). */
  discrimination: number;
  flag: ItemFlag;
}

function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / n;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Statistics for each item of one quiz, from every attempt's grades (one Grade per item, in quiz order).
 * Discrimination correlates an item's score with the total of the *other* items, so an item doesn't
 * inflate its own correlation.
 */
export function itemStatistics(itemIds: readonly string[], attempts: readonly (readonly Grade[])[]): ItemStats[] {
  const totals = attempts.map((grades) => grades.reduce((sum, grade) => sum + grade.score, 0));
  return itemIds.map((item_id, i) => {
    const scores = attempts.map((grades) => grades[i]!.score);
    const rest = attempts.map((_, a) => totals[a]! - scores[a]!);
    const responses = scores.length;
    const discrimination = responses > 1 ? correlation(scores, rest) : 0;
    const flag: ItemFlag =
      responses < MIN_ITEM_RESPONSES
        ? "too_few_responses"
        : discrimination < 0
          ? "negative_discrimination"
          : discrimination < MIN_DISCRIMINATION
            ? "weak_discrimination"
            : "ok";
    return {
      item_id,
      responses,
      difficulty: round2(scores.reduce((a, b) => a + b, 0) / Math.max(1, responses)),
      discrimination: round2(discrimination),
      flag,
    };
  });
}
