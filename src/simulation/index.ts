import { computePerformance } from "../analytics/performance.js";
import { type CourseSnapshot, compileCourse } from "../course/compile.js";
import { getCourse } from "../course/load.js";
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
export function scenarioSnapshot(scenario: Scenario): CourseSnapshot {
  const course = getCourse();
  const published = publishedGraph(course, scenario);
  const snapshot = compileCourse(course);
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
