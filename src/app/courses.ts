import type { EditContext } from "../edit/run.js";
import type { EditRequest, EditResult } from "../edit/types.js";
import { baseSnapshot } from "../course/bundle.js";
import type { CourseSnapshot } from "../course/compile.js";
import type { BuildInput, BuildResult, BuildStep } from "../generate/types.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import type { Intervention } from "../interventions/templates.js";
import type { StructuredFactory } from "../models.js";
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

/**
 * Builds a course from its sources (src/generate). Injected, so the app doesn't depend on how generation
 * works and tests can pass a fake. `structured` makes models with the course owner's key.
 */
export type CourseBuilder = (input: BuildInput, structured: StructuredFactory, onStep: (step: BuildStep) => void) => Promise<BuildResult>;

/** Turns an owner's request into proposed changes (src/edit), with the owner's key. Injected like the builder. */
export type CourseEditor = (request: EditRequest, context: EditContext, structured: StructuredFactory, onStep: (step: BuildStep) => void) => Promise<EditResult>;

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

// ─── Which objects may exist ─────────────────────────────────────────
// Routing a request to a Durable Object name creates that object, so the Worker checks the name first:
// a typo or a guessed id must not leave an empty course behind.

/** The one directory object's name. */
export const DIRECTORY_NAME = "main";

/** Ids the directory gives studio courses: "c-" and 12 random lowercase letters or digits. */
const STUDIO_ID = /^c-[a-z0-9]{12}$/;

export const isStudioId = (id: string) => STUDIO_ID.test(id);

/** A new studio course id, from WebCrypto randomness. */
export function newCourseId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 is the largest multiple of 36 below 256: rejecting bytes above it keeps every character equally likely.
  const out: string[] = [];
  while (out.length < 12) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 252 && out.length < 12) out.push(alphabet[byte % 36]!);
  }
  return `c-${out.join("")}`;
}

/** An agent route as the Agents SDK resolves it: the binding name and the object's name. */
export interface AgentRoute {
  className: string;
  name: string;
}

/**
 * Whether a request may reach (and so create) this object: a built-in course, a studio course the
 * directory has created, or the directory itself. Anything else is refused before routing.
 */
export async function routeAllowed(route: AgentRoute, courseExists: (id: string) => Promise<boolean>): Promise<boolean> {
  if (route.className === "DirectoryAgent") return route.name === DIRECTORY_NAME;
  if (route.className !== "CourseAgent") return false;
  if (isBuiltIn(route.name)) return true;
  return isStudioId(route.name) && (await courseExists(route.name));
}
