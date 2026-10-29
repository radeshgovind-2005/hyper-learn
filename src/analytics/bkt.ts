// Bayesian Knowledge Tracing: the probability that a learner has mastered a knowledge component
// (here, a lesson), updated after every graded answer. A two-state hidden Markov model with four
// parameters. These are defaults, not fitted to data: treat mastery as a heuristic until they are.

export interface BktParams {
  /** P(L0): mastered before the first answer. */
  prior: number;
  /** P(T): chance of learning between two answers. */
  learn: number;
  /** P(G): answering right without mastery. */
  guess: number;
  /** P(S): answering wrong despite mastery. */
  slip: number;
}

export const DEFAULT_BKT: BktParams = { prior: 0.2, learn: 0.1, guess: 0.25, slip: 0.1 };

/** A learner counts as having mastered a lesson at or above this probability. */
export const MASTERY_THRESHOLD = 0.95;

/** P(mastered) after observing one answer, including the chance of learning from it. */
export function bktUpdate(pMastered: number, correct: boolean, params: BktParams = DEFAULT_BKT): number {
  const { guess, slip, learn } = params;
  const posterior = correct
    ? (pMastered * (1 - slip)) / (pMastered * (1 - slip) + (1 - pMastered) * guess)
    : (pMastered * slip) / (pMastered * slip + (1 - pMastered) * (1 - guess));
  return posterior + (1 - posterior) * learn;
}

/** P(mastered) after a sequence of answers, starting from the prior. */
export function bktMastery(answers: readonly boolean[], params: BktParams = DEFAULT_BKT): number {
  return answers.reduce((p, correct) => bktUpdate(p, correct, params), params.prior);
}
