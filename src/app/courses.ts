import { baseSnapshot } from "../course/bundle.js";
import type { CourseSnapshot } from "../course/compile.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import type { Intervention } from "../interventions/templates.js";
import { SCENARIOS, type Scenario } from "../simulation/scenarios.js";

// Which courses exist. Built-in ones ship with the code; studio courses are created by the directory
// and keep their definition in their own course object's storage.

/** Everything a course object needs to know about its course that isn't learner data. */
export interface CourseDefinition {
  id: string;
  /** Release v1.0.0, as compiled or as published from a build. */
  base: CourseSnapshot;
  /** Simulated-learner scenarios; none for studio courses, so their runs use real learners only. */
  scenarios: readonly Scenario[];
  /** The scenario a fresh course object starts from. Default: the first. */
  defaultScenario?: string;
  /** Hand-written interventions a reference run (no model) can release. */
  exemplars: readonly Intervention[];
}

/** The course everyone sees, with global roles: production data lives in its object, so its name never changes. */
export const FEATURED_COURSE = "agentic-coding";

const BUILT_IN = new Map<string, () => CourseDefinition>([
  [
    FEATURED_COURSE,
    () => ({ id: FEATURED_COURSE, base: baseSnapshot(), scenarios: SCENARIOS, defaultScenario: "dominant-misconception", exemplars: EXEMPLARS }),
  ],
]);

export const BUILT_IN_COURSES: readonly string[] = [...BUILT_IN.keys()];

export const isBuiltIn = (id: string) => BUILT_IN.has(id);

/** A fresh copy of a built-in course's definition, or undefined for any other id. */
export const builtInCourse = (id: string): CourseDefinition | undefined => BUILT_IN.get(id)?.();
