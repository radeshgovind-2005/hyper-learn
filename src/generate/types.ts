import type { CourseSnapshot } from "../course/compile.js";
import type { Source } from "../course/sources.js";

// The contract between course generation (src/generate) and the app that runs it (CourseService in the
// course's Durable Object). Generation is a pure function of its input and its models: it reads no
// storage and keeps no state between calls, so the app decides where sources, keys and drafts live.

export interface BuildInput {
  course_id: string;
  title: string;
  /** What the owner wants learners to be able to do, in their words. */
  goal?: string;
  description?: string;
  /** Language to write in; default: the language of the material. */
  language?: string;
  sources: Source[];
}

/** One line of progress, shown to the owner while the course is built. */
export interface BuildStep {
  stage: "classify" | "digest" | "plan" | "write" | "assess" | "validate" | "review" | "stress" | "done";
  title: string;
  detail?: string;
  status: "ok" | "rejected" | "info" | "waiting";
  at: string;
}

export interface BuildReport {
  steps: BuildStep[];
  /** Model calls made, for the owner's cost estimate. */
  model_calls: number;
  /** Anything the owner should look at before publishing (weak grounding, thin pools…). */
  warnings: string[];
}

export type BuildResult =
  | { ok: true; snapshot: CourseSnapshot; report: BuildReport }
  | { ok: false; problems: string[]; report: BuildReport };
