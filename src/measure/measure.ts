import { gradeAttempt } from "../analytics/performance.js";
import type { CourseSnapshot } from "../course/compile.js";
import type { Course, PrereqGraph } from "../course/schema.js";
import { type Change, findNode } from "../releases/changes.js";
import type { Release } from "../releases/release.js";
import { simulate, type QuizAttempt } from "../simulation/learners.js";
import type { Scenario } from "../simulation/scenarios.js";
import { compare, type Measurement, outcome } from "./decide.js";

/** Measures a trial release against the live one. */
export interface Measurer {
  measure(live: Release, candidate: Release): Promise<Measurement>;
}

/** The lesson a change is about, and what it must do there. */
export function trialTarget(snapshot: CourseSnapshot, change: Change): { lesson: string; expectation: Measurement["expectation"] } {
  switch (change.op) {
    case "add_prerequisite":
      return { lesson: change.lesson, expectation: "improve" };
    case "remove_prerequisite":
      return { lesson: change.lesson, expectation: "no_harm" };
    case "archive_node":
    case "restore_node": {
      const ref = findNode(snapshot, change.node_id);
      if (!ref) throw new Error(`No node "${change.node_id}"`);
      return { lesson: ref.lesson.id, expectation: "no_harm" };
    }
  }
}

/** The prerequisite graph learners are routed through in a release: archived lessons are skipped. */
export function publishedGraphOf(snapshot: CourseSnapshot): PrereqGraph {
  const live = snapshot.lessons.filter((lesson) => !lesson.archived);
  const ids = new Set(live.map((lesson) => lesson.id));
  return Object.fromEntries(live.map((lesson) => [lesson.id, lesson.prerequisites.filter((p) => ids.has(p))]));
}

/** Attempts and failures per lesson. */
export function failuresByLesson(course: Course, attempts: readonly QuizAttempt[]): Map<string, { attempts: number; hits: number }> {
  const counts = new Map<string, { attempts: number; hits: number }>();
  for (const attempt of attempts) {
    const lesson = course.getLesson(attempt.lesson_id);
    if (!lesson) continue;
    const entry = counts.get(lesson.id) ?? { attempts: 0, hits: 0 };
    entry.attempts++;
    if (!gradeAttempt(lesson, attempt).passed) entry.hits++;
    counts.set(lesson.id, entry);
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
    const { lesson, expectation } = trialTarget(live.snapshot, change);

    const arm = (snapshot: CourseSnapshot) =>
      failuresByLesson(
        this.truth,
        simulate(this.truth, this.scenario, { seed: this.seed, published: publishedGraphOf(snapshot) }).attempts,
      );
    const control = arm(live.snapshot);
    const treatment = arm(candidate.snapshot);
    const comparison = (id: string) => {
      const c = control.get(id) ?? { attempts: 0, hits: 0 };
      const t = treatment.get(id) ?? { attempts: 0, hits: 0 };
      return compare(id, "fail_rate", outcome(c.attempts, c.hits), outcome(t.attempts, t.hits));
    };

    return {
      source: "simulation",
      seed: this.seed,
      expectation,
      primary: comparison(lesson),
      guardrails: [...control.keys()].filter((id) => id !== lesson).map(comparison),
    };
  }
}
