import { gradeAttempt } from "../analytics/performance.js";
import { type CourseSnapshot, liveInterventions } from "../course/compile.js";
import type { Course, PrereqGraph } from "../course/schema.js";
import { type Change, findNode } from "../releases/changes.js";
import type { Release } from "../releases/release.js";
import { simulate, type QuizAttempt } from "../simulation/learners.js";
import type { Scenario } from "../simulation/scenarios.js";
import { type Comparison, compare, type Measurement, outcome } from "./decide.js";
import type { PendingMeasurement } from "./real.js";

/** Measures a trial release against the live one; a real-learner measurer may not have enough data yet. */
export interface Measurer {
  measure(live: Release, candidate: Release): Promise<Measurement | PendingMeasurement>;
}

/** What a trial measures for a change: which lesson, which metric, and what the change must do to it. */
export interface TrialTarget {
  lesson: string;
  metric: Comparison["metric"];
  misconception?: string;
  expectation: Measurement["expectation"];
}

export function trialTarget(snapshot: CourseSnapshot, change: Change): TrialTarget {
  switch (change.op) {
    case "add_prerequisite":
      return { lesson: change.lesson, metric: "fail_rate", expectation: "improve" };
    case "remove_prerequisite":
      return { lesson: change.lesson, metric: "fail_rate", expectation: "no_harm" };
    case "add_block": {
      const ref = findNode(snapshot, change.section_id);
      if (!ref) throw new Error(`No section "${change.section_id}"`);
      return { lesson: ref.lesson.id, metric: "misconception_rate", misconception: change.intervention.targets, expectation: "improve" };
    }
    case "archive_node":
    case "restore_node":
    case "remove_block": {
      const id = change.op === "remove_block" ? change.block_id : change.node_id;
      const ref = findNode(snapshot, id);
      if (!ref) throw new Error(`No node "${id}"`);
      return { lesson: ref.lesson.id, metric: "fail_rate", expectation: "no_harm" };
    }
    // Owner edits: a rewrite or new material in a lesson must at least not make its exam harder to pass.
    case "insert_block":
    case "add_section":
    case "remove_section": {
      const id = change.op === "add_section" ? change.lesson_id : change.section_id;
      const ref = findNode(snapshot, id);
      if (!ref) throw new Error(`No node "${id}"`);
      return { lesson: ref.lesson.id, metric: "fail_rate", expectation: "no_harm" };
    }
    case "add_items":
    case "remove_items":
      return { lesson: change.lesson_id, metric: "fail_rate", expectation: "no_harm" };
    case "add_lesson":
      return { lesson: change.lesson.id, metric: "fail_rate", expectation: "no_harm" };
    case "remove_lesson":
      return { lesson: change.lesson_id, metric: "fail_rate", expectation: "no_harm" };
  }
}

/** The prerequisite graph learners are routed through in a release: archived lessons are skipped. */
export function publishedGraphOf(snapshot: CourseSnapshot): PrereqGraph {
  const live = snapshot.lessons.filter((lesson) => !lesson.archived);
  const ids = new Set(live.map((lesson) => lesson.id));
  return Object.fromEntries(live.map((lesson) => [lesson.id, lesson.prerequisites.filter((p) => ids.has(p))]));
}

type Counts = { attempts: number; hits: number };

/** Per lesson: learners who took it, and how many failed their last attempt (after any retake). */
export function finalFailures(course: Course, attempts: readonly QuizAttempt[]): Map<string, Counts> {
  const last = new Map<string, QuizAttempt>();
  for (const attempt of attempts) last.set(`${attempt.learner_id}:${attempt.lesson_id}`, attempt);
  const counts = new Map<string, Counts>();
  for (const attempt of last.values()) {
    const lesson = course.getLesson(attempt.lesson_id);
    if (!lesson) continue;
    const entry = counts.get(lesson.id) ?? { attempts: 0, hits: 0 };
    entry.attempts++;
    if (!gradeAttempt(lesson, attempt).passed) entry.hits++;
    counts.set(lesson.id, entry);
  }
  return counts;
}

const shows = (course: Course, attempt: QuizAttempt, misconception: string) => {
  const lesson = course.getLesson(attempt.lesson_id)!;
  return gradeAttempt(lesson, attempt).grades.some((g) => g.errors.some((e) => e.misconception === misconception));
};

/**
 * Of the learners who failed `lessonId` showing `misconception`, how many still show it when they retake
 * the quiz. Lower is better: that is the misconception being resolved.
 */
export function persistence(course: Course, attempts: readonly QuizAttempt[], lessonId: string, misconception: string): Counts {
  const retakes = new Map(
    attempts.filter((a) => a.lesson_id === lessonId && a.attempt === 2).map((a) => [a.learner_id, a] as const),
  );
  const counts = { attempts: 0, hits: 0 };
  for (const first of attempts) {
    if (first.lesson_id !== lessonId || (first.attempt ?? 1) !== 1) continue;
    const retake = retakes.get(first.learner_id);
    if (!retake || !shows(course, first, misconception)) continue;
    counts.attempts++;
    if (shows(course, retake, misconception)) counts.hits++;
  }
  return counts;
}

/**
 * Measures a trial on simulated learners: the same seeded cohort is routed through the live release
 * and through the candidate, and the outcomes are compared. The seed differs from the one the diagnosis
 * used, so the trial isn't judged on the data that suggested it.
 *
 * Honest scope: learners in the simulation follow rules we wrote (the scenario's truth), so this tests
 * targeting, the decision rule and revert under noise. It cannot show that content teaches real people.
 */
export class SimMeasurer implements Measurer {
  constructor(
    private readonly truth: Course,
    private readonly scenario: Scenario,
    private readonly seed = scenario.seed + 1000,
  ) {}

  async measure(live: Release, candidate: Release): Promise<Measurement> {
    const change = candidate.changes[0];
    if (!change) throw new Error(`Release ${candidate.version} has no changes to measure`);
    const target = trialTarget(live.snapshot, change);

    // Both arms: the same learners (same seed), retaking after the router's remediation.
    const arm = (snapshot: CourseSnapshot) =>
      simulate(this.truth, this.scenario, {
        seed: this.seed,
        published: publishedGraphOf(snapshot),
        interventions: liveInterventions(snapshot),
        retakes: true,
      }).attempts;
    const control = arm(live.snapshot);
    const treatment = arm(candidate.snapshot);
    const controlFails = finalFailures(this.truth, control);
    const treatmentFails = finalFailures(this.truth, treatment);
    const failRate = (id: string) => {
      const c = controlFails.get(id) ?? { attempts: 0, hits: 0 };
      const t = treatmentFails.get(id) ?? { attempts: 0, hits: 0 };
      return compare(id, "fail_rate", outcome(c.attempts, c.hits), outcome(t.attempts, t.hits));
    };

    let primary: Comparison;
    if (target.metric === "misconception_rate") {
      const m = target.misconception!;
      const c = persistence(this.truth, control, target.lesson, m);
      const t = persistence(this.truth, treatment, target.lesson, m);
      primary = compare(target.lesson, "misconception_rate", outcome(c.attempts, c.hits), outcome(t.attempts, t.hits), m);
    } else {
      primary = failRate(target.lesson);
    }

    // Every lesson's fail rate is a guardrail, including the target's own when the primary is a misconception.
    const guardrails = [...controlFails.keys()]
      .filter((id) => target.metric === "misconception_rate" || id !== target.lesson)
      .map(failRate);
    return { source: "simulation", seed: this.seed, expectation: target.expectation, primary, guardrails };
  }
}
