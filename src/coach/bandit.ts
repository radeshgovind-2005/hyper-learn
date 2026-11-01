import type { Target } from "./diagnose.js";
import { type Approach, APPROACHES, approachFor } from "./repair.js";

// Choosing a personal lesson's approach by what has worked: Thompson sampling over how often each
// approach fixed learners on this target (shown vs fixed, from hl_coach_targets). Each approach's fix
// rate is drawn from its Beta posterior and the highest draw wins, so a good approach is chosen most of
// the time and the others still get tried now and then. Code decides; the model never picks.

/** Below this many personal lessons shown on a target, the fixed order (approachFor) decides. */
export const MIN_SAMPLES = 5;

export interface ApproachCount {
  approach: string;
  shown: number;
  fixed: number;
}

/** A standard normal draw (Box–Muller). */
function normal(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A Gamma(shape, 1) draw for shape ≥ 1 (Marsaglia and Tsang). */
function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function beta(a: number, b: number, random: () => number): number {
  const x = gamma(a, random);
  return x / (x + gamma(b, random));
}

/**
 * The approach for a target's next personal lesson. An approach nobody has tried yet starts from
 * Beta(1, 2): assumed to work about a third of the time, so it is explored without beating one that
 * has a record of working.
 */
export function chooseApproach(target: Target, attempt: number, counts: readonly ApproachCount[], random: () => number = Math.random): { approach: Approach; by: "bandit" | "order" } {
  const total = counts.reduce((sum, c) => sum + c.shown, 0);
  if (total < MIN_SAMPLES) return { approach: approachFor(target, attempt), by: "order" };
  let best: { approach: Approach; draw: number } | undefined;
  for (const approach of APPROACHES) {
    const c = counts.find((x) => x.approach === approach);
    const fixed = Math.min(c?.fixed ?? 0, c?.shown ?? 0);
    const draw = c && c.shown > 0 ? beta(fixed + 1, c.shown - fixed + 1, random) : beta(1, 2, random);
    if (!best || draw > best.draw) best = { approach, draw };
  }
  return { approach: best!.approach, by: "bandit" };
}
