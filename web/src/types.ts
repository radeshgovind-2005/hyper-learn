// Types shared with the core. Only types cross this line: the UI bundles none of the core's code.
import type { CourseRole } from "../../src/app/access.js";
import type { CourseCard } from "../../src/app/directory.js";
import type { CourseService, QuizResult } from "../../src/app/service.js";

export type {
  BuildState,
  CheckResult,
  CitedSource,
  DataSource,
  EditState,
  Exam,
  ItemResult,
  LessonProgress,
  OwnerSourceSummary,
  QuizResult,
  ReleaseSummary,
  RunState,
  ServedRelease,
  SourcePage,
  StudioRecord,
  TrialStatus,
} from "../../src/app/service.js";
export type { Citation } from "../../src/course/schema.js";
export type { Audience } from "../../src/generate/types.js";
export type { EditPreset, EditRequest, EditSummaryItem } from "../../src/edit/types.js";
export type { CourseRole } from "../../src/app/access.js";
export type { CourseCard, CourseStatus } from "../../src/app/directory.js";
export type { BuildStep } from "../../src/generate/types.js";
export type { SourceRole } from "../../src/course/sources.js";
export type { Member, SourceSummary } from "../../src/storage/studio.js";
export type { RunStep } from "../../src/app/timeline.js";
export type { Certainty, QuizItem, Response } from "../../src/assessment/items.js";
export type { Block, CourseSnapshot, LessonNode, LiveIntervention, Section } from "../../src/course/compile.js";
export type { Intervention } from "../../src/interventions/templates.js";
export type { Comparison, Measurement } from "../../src/measure/decide.js";
export type { ApprovalRequest, ApprovalResponse } from "../../src/nodes/release.js";

export type Overview = ReturnType<CourseService["overview"]>;
export type ModelSettings = ReturnType<CourseService["modelSettings"]>;
export type CourseDetails = ReturnType<CourseService["details"]>;
export type PathStep = QuizResult["steps"][number];
export interface AgentState {
  overview: Overview | null;
}

/** Who the server says I am, and what my role allows (see src/app/access.ts). */
export interface Me {
  userId: string;
  role: "learner" | "instructor" | "admin";
  /** My role in this course (studio courses; null on the featured one). */
  courseRole: CourseRole | null;
  permissions: string[];
  /** Whether the Worker can change roles (has Clerk's secret key). */
  rolesConfigured: boolean;
}

/** My courses, as the directory lists them. */
export interface MyCourses {
  owned: CourseCard[];
  shared: CourseCard[];
  featured: CourseCard[];
}

/** Calls a method on the course's Durable Object. */
export type Call = <T>(method: string, args?: unknown[]) => Promise<T>;
