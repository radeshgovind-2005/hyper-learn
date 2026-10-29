import { computePerformance } from "../analytics/performance.js";
import { baseSnapshot, getCourse } from "../course/bundle.js";
import { type CourseSnapshot, liveInterventions } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import { publishedGraphOf } from "../measure/measure.js";
import type { Mutation, NodePerformance } from "../state.js";
import { publishedGraph, simulate } from "./learners.js";
import type { Scenario } from "./scenarios.js";

/** Simulates a scenario on the default course and returns the per-lesson data the Curator sees. */
export function scenarioPerformance(scenario: Scenario, seed?: number): NodePerformance[] {
  const course = getCourse();
  const { published, attempts } = simulate(course, scenario, seed === undefined ? {} : { seed });
  return computePerformance(course, published, attempts);
}

/**
 * The release a scenario starts from: the compiled course (v1.0.0) with the scenario's faults in its
 * prerequisite graph, as if that is what had been published.
 */
export function scenarioSnapshot(scenario: Scenario, course: Course = getCourse(), base: CourseSnapshot = baseSnapshot()): CourseSnapshot {
  const published = publishedGraph(course, scenario);
  const snapshot = structuredClone(base);
  for (const lesson of snapshot.lessons) lesson.prerequisites = [...(published[lesson.id] ?? [])];
  return snapshot;
}

/** A scenario's injected proposal, with its reason citing the lesson's real fail rate as the code checks require. */
export function injectedProposal(scenario: Scenario, data: readonly NodePerformance[]): Mutation | undefined {
  const inject = scenario.inject;
  if (!inject) return undefined;
  const node = data.find((n) => n.node_id === inject.node_id);
  return { ...inject, reason: `${inject.node_id} fails ${node?.fail_rate ?? "?"}; ${inject.reason}` };
}

/**
 * Learner data for diagnosing a release: the scenario's learners (same seed and behaviour) routed
 * through the release's own prerequisite graph, with each named misconception marked `covered` when one
 * of the release's live interventions targets it. After a fix is kept, the next diagnosis sees its effect.
 */
export function releasePerformance(scenario: Scenario, snapshot: CourseSnapshot, course: Course = getCourse()): NodePerformance[] {
  const published = publishedGraphOf(snapshot);
  const covered = new Set(liveInterventions(snapshot).map((i) => i.intervention.targets));
  const { attempts } = simulate(course, scenario, { published });
  return computePerformance(course, published, attempts).map((node) => ({
    ...node,
    misconceptions: node.misconceptions.map((m) => ({ ...m, covered: covered.has(m.id) })),
  }));
}
