// Types shared with the core. Only types cross this line: the UI bundles none of the core's code.
import type { CourseService } from "../../src/app/service.js";

export type { DataSource, ItemResult, LessonProgress, QuizResult, ReleaseSummary, RunState, ServedRelease, TrialStatus } from "../../src/app/service.js";
export type { RunStep } from "../../src/app/timeline.js";
export type { Certainty, QuizItem, Response } from "../../src/assessment/items.js";
export type { Block, CourseSnapshot, LessonNode, LiveIntervention, Section } from "../../src/course/compile.js";
export type { Intervention } from "../../src/interventions/templates.js";
export type { Comparison, Measurement } from "../../src/measure/decide.js";
export type { ApprovalRequest, ApprovalResponse } from "../../src/nodes/release.js";

export type Overview = ReturnType<CourseService["overview"]>;
export interface AgentState {
  overview: Overview | null;
}

/** Who the server says I am, and what my role allows (see src/app/access.ts). */
export interface Me {
  userId: string;
  role: "learner" | "instructor" | "admin";
  permissions: string[];
  /** Whether the Worker can change roles (has Clerk's secret key). */
  rolesConfigured: boolean;
}

/** Calls a method on the course's Durable Object. */
export type Call = <T>(method: string, args?: unknown[]) => Promise<T>;
