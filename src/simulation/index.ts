import { computePerformance } from "../analytics/performance.js";
import { getCourse } from "../course/load.js";
import type { NodePerformance } from "../state.js";
import { simulate } from "./learners.js";
import type { Scenario } from "./scenarios.js";

/** Simulates a scenario on the default course and returns the per-lesson data the Curator sees. */
export function scenarioPerformance(scenario: Scenario, seed?: number): NodePerformance[] {
  const course = getCourse();
  const { published, attempts } = simulate(course, scenario, seed === undefined ? {} : { seed });
  return computePerformance(course, published, attempts);
}
