import type { Grade } from "../assessment/grade.js";

// Item analysis from classical test theory: is each question a working instrument?
// A question that strong learners fail more often than weak ones (negative discrimination) is
// broken (a wrong key, an ambiguous prompt), and diagnosing the course from it would mislead.

/** Fewer graded responses than this and an item's statistics are not judged. */
export const MIN_ITEM_RESPONSES = 30;
/** Discrimination below this is weak; confidently below 0, the item is excluded from diagnosis. */
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
 * Whether a correlation is below 0 with 95% confidence (Fisher's z). A drawn exam correlates an item with
 * only a few other items, so a small negative value is often noise; excluding a good item on noise would
 * throw away evidence. A miskeyed item is strongly negative and still caught.
 */
function confidentlyNegative(r: number, n: number): boolean {
  if (r >= 0 || n < 4) return false;
  const z = Math.atanh(Math.max(-0.999999, r));
  return Math.tanh(z + 1.96 / Math.sqrt(n - 3)) < 0;
}

/**
 * Statistics for each item of one quiz, from every attempt's grades (one entry per item, in `itemIds`
 * order; `undefined` = the attempt didn't show that item, as in an exam drawn from a pool). An item is
 * judged only on the attempts that showed it. Discrimination correlates an item's score with the mean
 * score of the *other* items shown in the same attempt, so an item doesn't inflate its own correlation;
 * when every attempt shows every item this is the classic corrected item-total correlation.
 */
export function itemStatistics(itemIds: readonly string[], attempts: readonly (readonly (Grade | undefined)[])[]): ItemStats[] {
  const shown = attempts.map((grades) => grades.filter((grade): grade is Grade => grade !== undefined));
  const totals = shown.map((grades) => grades.reduce((sum, grade) => sum + grade.score, 0));
  return itemIds.map((item_id, i) => {
    const scores: number[] = [];
    const xs: number[] = [];
    const rest: number[] = [];
    attempts.forEach((grades, a) => {
      const grade = grades[i];
      if (!grade) return;
      scores.push(grade.score);
      const others = shown[a]!.length - 1;
      if (others === 0) return; // nothing to correlate with
      xs.push(grade.score);
      rest.push((totals[a]! - grade.score) / others);
    });
    const responses = scores.length;
    const discrimination = xs.length > 1 ? correlation(xs, rest) : 0;
    const flag: ItemFlag =
      responses < MIN_ITEM_RESPONSES
        ? "too_few_responses"
        : confidentlyNegative(discrimination, xs.length)
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
