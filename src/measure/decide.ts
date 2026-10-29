import { wilsonInterval } from "../analytics/performance.js";

// The keep-or-revert decision for a trial, in code. Agents propose; this decides.

/** Fewer attempts than this in either arm and nothing is concluded. */
export const MIN_ARM_ATTEMPTS = 30;
/** An "improve" change must lower the primary rate by at least this much (absolute). */
export const MIN_EFFECT = 0.1;
/** A "no harm" change (e.g. removing a prerequisite) may not raise the primary rate by this much. */
export const NON_INFERIORITY_MARGIN = 0.05;
/** A guardrail lesson getting worse by at least this much, with confidence, reverts the trial. */
export const GUARDRAIL_MARGIN = 0.05;

export interface ArmOutcome {
  attempts: number;
  /** Attempts with the bad outcome: a failed quiz, or the targeted misconception shown. */
  hits: number;
  rate: number;
}

export interface Comparison {
  lesson: string;
  metric: "fail_rate" | "misconception_rate";
  /** For misconception_rate: which misconception. */
  misconception?: string;
  control: ArmOutcome;
  treatment: ArmOutcome;
  /** treatment − control: negative = the change helped. */
  diff: number;
  /** 95% confidence interval for diff. */
  diff_ci: [number, number];
}

export interface Measurement {
  /** Simulated learners prove the machinery, not the pedagogy; real learners are the real test. */
  source: "simulation" | "learners";
  seed?: number;
  /** What the change must do to the primary metric: lower it, or at least not raise it. */
  expectation: "improve" | "no_harm";
  primary: Comparison;
  guardrails: Comparison[];
}

export interface TrialDecision {
  verdict: "keep" | "revert";
  reasons: string[];
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * 95% CI for the difference of two independent proportions (treatment − control), by Newcombe's
 * hybrid score method: it combines the two Wilson intervals and behaves well near 0 and 1.
 */
export function differenceInterval(control: ArmOutcome, treatment: ArmOutcome): [number, number] {
  const [l1, u1] = wilsonInterval(control.hits, control.attempts);
  const [l2, u2] = wilsonInterval(treatment.hits, treatment.attempts);
  const p1 = control.rate;
  const p2 = treatment.rate;
  const d = p2 - p1;
  return [round3(d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2)), round3(d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2))];
}

export const outcome = (attempts: number, hits: number): ArmOutcome => ({
  attempts,
  hits,
  rate: attempts === 0 ? 0 : round3(hits / attempts),
});

export function compare(
  lesson: string,
  metric: Comparison["metric"],
  control: ArmOutcome,
  treatment: ArmOutcome,
  misconception?: string,
): Comparison {
  return {
    lesson,
    metric,
    ...(misconception && { misconception }),
    control,
    treatment,
    diff: round3(treatment.rate - control.rate),
    diff_ci: differenceInterval(control, treatment),
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const describe = (c: Comparison) =>
  `${c.lesson} ${c.metric === "fail_rate" ? "fail rate" : `${c.misconception} rate`} ` +
  `${pct(c.control.rate)} → ${pct(c.treatment.rate)} (Δ ${c.diff >= 0 ? "+" : ""}${pct(c.diff)}, ` +
  `95% CI ${pct(c.diff_ci[0])}…${pct(c.diff_ci[1])})`;

/**
 * Keep a trial only if it did what it claimed with confidence and broke nothing else; otherwise
 * revert. An inconclusive result reverts too: the simpler course wins by default.
 */
export function decideTrial(m: Measurement): TrialDecision {
  const { primary } = m;
  if (primary.control.attempts < MIN_ARM_ATTEMPTS || primary.treatment.attempts < MIN_ARM_ATTEMPTS) {
    return { verdict: "revert", reasons: [`too few attempts to conclude (need ${MIN_ARM_ATTEMPTS} per arm): ${describe(primary)}`] };
  }

  const primaryOk =
    m.expectation === "improve"
      ? primary.diff <= -MIN_EFFECT && primary.diff_ci[1] < 0
      : primary.diff_ci[1] < NON_INFERIORITY_MARGIN;
  const primaryReason =
    m.expectation === "improve"
      ? primaryOk
        ? `improved: ${describe(primary)}`
        : `no confident improvement of at least ${pct(MIN_EFFECT)}: ${describe(primary)}`
      : primaryOk
        ? `no harm (worst case under +${pct(NON_INFERIORITY_MARGIN)}): ${describe(primary)}`
        : `could be harmful (worst case +${pct(primary.diff_ci[1])}): ${describe(primary)}`;

  const regressions = m.guardrails
    .filter((g) => g.diff >= GUARDRAIL_MARGIN && g.diff_ci[0] > 0)
    .map((g) => `guardrail regressed: ${describe(g)}`);

  return { verdict: primaryOk && regressions.length === 0 ? "keep" : "revert", reasons: [primaryReason, ...regressions] };
}
