import { Command } from "@langchain/langgraph";
import { z } from "zod";
import { bktMastery, MASTERY_THRESHOLD } from "../analytics/bkt.js";
import { beliefsOf, interventionsOf, quizHistory, sessionsOf, timelineOf, timePerLesson, TrackEventSchema } from "../analytics/learner.js";
import type { Identity } from "../auth/identity.js";
import { gradeAttempt } from "../analytics/performance.js";
import { type Grade, gradeItem } from "../assessment/grade.js";
import { drawExam, examSeed } from "../assessment/exam.js";
import type { Certainty, QuizItem, Response } from "../assessment/items.js";
import { type CheckBlock, type CourseSnapshot, courseFromSnapshot, isTextBlock, type LiveIntervention, liveInterventions, liveObjectives } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import { buildGraph, graphModels } from "../graph.js";
import type { Embedder, Guard } from "../guards/guards.js";
import { SimMeasurer } from "../measure/measure.js";
import { type Arm, armOf, isPending, measureReal, type PendingMeasurement, RealMeasurer, realPerformance } from "../measure/real.js";
import { createApprover, createApproverModel } from "../nodes/approver.js";
import { type ApprovalMode, type ApprovalRequest, type ApprovalResponse, type Harness, settleTrial } from "../nodes/release.js";
import { nextSteps, type PathStep } from "../path/route.js";
import { applyChanges, type Change, describeChange, invertChanges, maxBump, maxTier, riskTier, semverBump } from "../releases/changes.js";
import { type Release, type ReleaseInfo, revert } from "../releases/release.js";
import { releasePerformance, scenarioSnapshot } from "../simulation/index.js";
import type { Scenario } from "../simulation/scenarios.js";
import { NoExemplar } from "../interventions/reference.js";
import { defaultModels, type ModelConfig, ModelProvider } from "../models.js";
import { keysAvailable, openSecret, sealSecret } from "../crypto/keys.js";
import { MAX_PAGE_CHARS, SOURCE_ROLES, type Source, type SourceRole, SourceSchema } from "../course/sources.js";
import type { State } from "../state.js";
import { PersistentMemorySaver } from "../storage/checkpointer.js";
import { type LearnerEvent, type Sql, SqlEventLog, SqlMeta, SqlProfiles, SqlReleaseStore, SqlThreadStore } from "../storage/sql.js";
import { type Member, SqlMembers, SqlSources, type SourceSummary } from "../storage/studio.js";
import type { Identity as Person } from "../auth/identity.js";
import { COURSE_ROLES, type CourseRole } from "./access.js";
import { builtInCourse, type CoachRepairer, type CourseBuilder, type CourseDefinition, type CourseEditor, FEATURED_COURSE, isStudioId } from "./courses.js";
import { type DiagnosisResult, drawDiagnostic, scoreDiagnostic, type Target, targetKey } from "../coach/diagnose.js";
import { type Approach, approachFor, type PersonalSection, recheckItems, sectionsFor } from "../coach/repair.js";
import type { Audience, BuildStep } from "../generate/types.js";
import { bumpVersion, initialRelease } from "../releases/release.js";
import { EDIT_PRESETS, type EditProposal, type EditRequest } from "../edit/types.js";
import { type CourseDetailsInput, CourseDetailsSchema, type CourseRecord, type CourseStatus, firstIssue } from "./directory.js";
import { approveWithinCeiling, referenceModels } from "./reference.js";
import { flushTraces, traceConfig } from "../observability.js";
import { type RunStep, stepFor } from "./timeline.js";

// The application behind the UI, independent of where it runs: the Worker's Durable Object wraps it,
// tests run it on Node's SQLite. Everything it remembers lives in `sql`.

/** Most activity events one connection may report per minute. */
export const TRACK_EVENTS_PER_MINUTE = 60;

/** Whose answers a run diagnoses and trials on: the scenario's simulated learners, or the people using the app. */
export type DataSource = "simulated" | "real";

export interface RunState {
  thread_id: string;
  scenario: string;
  mode: ApprovalMode;
  /** true = the real agents on a model; false = the reference stand-ins (no model calls). */
  agents: boolean;
  /** Missing on runs stored before real learners existed: simulated. */
  source?: DataSource;
  /** trial_running: a trial on real learners started and is collecting answers; it's decided later. */
  status: "running" | "awaiting_approval" | "trial_running" | "done" | "error";
  steps: RunStep[];
  approval?: ApprovalRequest;
  error?: string;
  started_at: string;
}

/** What the UI lists for each release. */
export interface ReleaseSummary {
  version: string;
  parent: string | null;
  status: Release["status"];
  tier: Release["tier"];
  bump: Release["bump"];
  changes: string[];
  rationale?: string;
  approval?: Release["approval"];
  measurement?: Release["measurement"];
  decision?: Release["decision"];
  promoted_to?: string;
  released_from?: string;
  trial_source?: Release["trial_source"];
  pending?: PendingMeasurement;
  created_at: string;
}

/** A trial on real learners that hasn't been decided yet. */
export interface TrialStatus {
  version: string;
  parent: string;
  started_at: string;
  changes: string[];
  /** Learners counted so far in each arm, as of the last evaluation. */
  pending?: PendingMeasurement;
}

/** The release one learner is served: during a real trial, half of learners get the trial. */
export interface ServedRelease {
  version: string;
  /** Set while a real trial is running: which arm this learner is in. */
  arm?: Arm;
}

export interface ItemResult {
  item_id: string;
  pilot: boolean;
  grade: Grade;
}

export interface QuizResult {
  release: string;
  passed: boolean;
  score: number;
  items: ItemResult[];
  steps: PathStep[];
  /** The interventions the steps point to, so the UI can render them. */
  interventions: LiveIntervention[];
  /** BKT P(mastered) for this lesson after this attempt. */
  mastery: number;
}

export interface LessonProgress {
  lesson: string;
  attempts: number;
  passed: boolean;
  mastery: number;
  mastered: boolean;
  /** Misconceptions shown in the latest attempt. */
  beliefs: string[];
  /** Objectives answered wrongly in the latest attempt; only for lessons with objectives. */
  missed_objectives?: string[];
}

/** The questions one attempt at a lesson shows a learner, drawn from its pool (see drawExam). */
export interface Exam {
  release: string;
  lesson: string;
  /** Which attempt this is for the learner (1 = first). */
  attempt: number;
  items: QuizItem[];
}

export interface CheckResult {
  correct: boolean;
  feedback: string;
}

export interface RunOptions {
  mode: ApprovalMode;
  agents: boolean;
  /** Whose answers to diagnose and trial on. Default: simulated. */
  source?: DataSource;
}

/** A studio course as its own object stores it. */
export interface StudioRecord {
  id: string;
  title: string;
  description: string;
  /** What the owner wants learners to be able to do, in their words: guides the build. */
  goal: string;
  /** Language to write in; empty: the material's. */
  language: string;
  /** Who it is for. Missing on records stored before audiences existed: read as "beginner" (see record()). */
  audience: Audience;
  status: CourseStatus;
  owner: string;
  created_at: string;
}

/** A source as the owner's list shows it. */
export interface OwnerSourceSummary extends SourceSummary {
  /** Whether learners may open it from the lessons that cite it (past exams and briefs never, whatever this says). */
  shared: boolean;
}

/** A file a learner may open from the lessons that cite it. */
export interface CitedSource {
  id: string;
  name: string;
  pages: number;
}

/** One page of a source, as the viewer shows it. */
export interface SourcePage {
  source: CitedSource;
  /** 1-based. */
  page: number;
  text: string;
}

/** Files learners never see: they show what is assessed, and may hold the answers. */
const NEVER_SHOWN: ReadonlySet<SourceRole> = new Set(["assessment", "brief"]);

/** How a course object tells the directory what changed, so course lists stay current. */
export interface DirectoryLink {
  courseUpdated(id: string, patch: Partial<Pick<CourseRecord, "title" | "description" | "status">>): Promise<void>;
  membershipChanged(id: string, userId: string, role: CourseRole | null): Promise<void>;
}

// Callable arguments arrive from browsers untyped: `approved: "false"` is truthy, so check shapes here.
const RunOptionsSchema = z.strictObject({
  mode: z.enum(["hitl", "autopilot"]),
  agents: z.boolean(),
  source: z.enum(["simulated", "real"]).optional(),
});

const ApprovalResponseSchema = z.strictObject({
  approved: z.boolean(),
  note: z.string().trim().max(1_000).optional(),
});

/** An approval answer from a browser, checked. */
export function parseApproval(input: unknown): ApprovalResponse {
  const parsed = ApprovalResponseSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid approval: ${firstIssue(parsed.error)}`);
  return parsed.data;
}

const DetailsUpdateSchema = z.strictObject({
  title: CourseDetailsSchema.shape.title.optional(),
  description: CourseDetailsSchema.shape.description.optional(),
  goal: z.string().trim().max(2_000).optional(),
  language: z.string().trim().max(40).optional(),
  audience: CourseDetailsSchema.shape.audience.unwrap().optional(),
});

/** Compares secrets in time that doesn't depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** A learner call on a course that has no live release yet. */
export class NotPublished extends Error {
  constructor() {
    super("This course isn't published yet");
  }
}

/** How a studio course reaches a model with its owner's key. The Worker fills this from its env. */
export interface OwnerModelSettings {
  /** KEY_ENCRYPTION_SECRET. Without it keys can't be saved or used. */
  secret: string | undefined;
  /** Everything but the key and model names. The base URL is always the Worker's (MODEL_BASE_URL), never the owner's. */
  config: ModelConfig;
  /** Models an owner may pick (MODEL_CHOICES). */
  choices: readonly string[];
}

/** Limits on what an owner uploads, enforced here whatever the UI does. */
export const SOURCE_LIMITS = {
  sources: 30,
  /** All sources together. */
  chars: 2_000_000,
  /** One addSource or appendPages call: bigger files arrive in several (WebSocket messages are bounded). */
  charsPerCall: 500_000,
  pagesPerSource: 2_000,
} as const;

const SourceUploadSchema = z.strictObject({
  name: z.string().trim().min(1, "Name the file").max(200),
  role: z.enum(SOURCE_ROLES).optional(),
  pages: z.array(z.string()).min(1, "A file needs at least one page"),
});

const MODEL_KEY = z
  .string()
  .trim()
  .min(8, "That doesn't look like an API key")
  .max(400, "That doesn't look like an API key")
  .regex(/^\S+$/, "An API key has no spaces");

/** What's stored for a studio course's model: the key sealed, never in the clear. */
interface StoredModelKey {
  sealed: string;
  model: string;
  set_at: string;
}

/** A studio course's build, as the owner watches it. */
export interface BuildState {
  status: "running" | "done" | "failed";
  steps: BuildStep[];
  started_at: string;
  finished_at?: string;
  /** Why a build failed: the generator's problems, or an error. */
  problems?: string[];
  /** What the owner should look at before publishing. */
  warnings?: string[];
  model_calls?: number;
}

/** A question the coach shows, by id: the item is looked up in the release it was drawn from. */
interface CoachQuestion {
  lesson: string;
  item_id: string;
}

/** One learner's study coach: their latest diagnosis and repair, and what they have fixed. */
export interface CoachState {
  diagnosis?: {
    id: string;
    lesson: string;
    release: string;
    note?: string;
    started_at: string;
    questions: CoachQuestion[];
    status: "open" | "done";
    result?: DiagnosisResult;
  };
  repair?: {
    id: string;
    target: Target;
    approach: Approach;
    /** How many approaches have been tried on this target before this one. */
    attempt: number;
    release: string;
    status: "running" | "ready" | "failed" | "fixed" | "not_yet";
    started_at: string;
    finished_at?: string;
    lesson?: PersonalSection;
    /** Without a model (the featured course, or no key): the course's own help instead of a new lesson. */
    fallback?: { kind: "intervention"; block_id: string } | { kind: "review"; lesson: string; section_id: string };
    problems?: string[];
    recheck?: CoachQuestion[];
  };
  /** Target keys the learner has fixed (re-check passed). */
  fixed: string[];
  /** Every question the coach has shown, so exams prefer others. */
  seen: string[];
  repairs_today: { date: string; count: number };
}

/** Personal repair lessons one learner may ask for in a day: each costs the owner a few model calls. */
export const MAX_REPAIRS_PER_DAY = 8;

/** An owner's edit request, from asking to applying (studio courses). */
export interface EditState {
  id: string;
  request: EditRequest;
  /** Who asked. */
  by: string;
  status: "running" | "ready" | "applied" | "discarded" | "failed";
  steps: BuildStep[];
  started_at: string;
  finished_at?: string;
  /** What it was computed on: the draft (by revision) or a release. Applying needs it unchanged. */
  base: { kind: "draft"; rev: number } | { kind: "release"; version: string };
  proposal?: EditProposal;
  problems?: string[];
  warnings?: string[];
  model_calls?: number;
  /** "draft", or the version it was released as. */
  applied_as?: string;
}

// Requests arrive from browsers untyped; the presets are the keys of EDIT_PRESETS.
const EditRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tune"),
    section_id: z.string().min(1).max(200),
    preset: z.enum(Object.keys(EDIT_PRESETS) as [keyof typeof EDIT_PRESETS, ...(keyof typeof EDIT_PRESETS)[]]).optional(),
    instruction: z.string().trim().max(2_000).optional(),
  }),
  z.strictObject({ kind: z.literal("ask"), instruction: z.string().trim().min(3, "Say what you'd like to change").max(2_000) }),
  z.strictObject({ kind: z.literal("add_source"), source_id: z.string().min(1).max(20), instruction: z.string().trim().max(2_000).optional() }),
]);

/** Any paged list: a page size (50 by default, at most 200) and the cursor the last page returned. */
const PageQuerySchema = z.strictObject({
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** The instructors' list: a page size (50 by default, at most 200), a cursor, and a filter. */
const LearnersQuerySchema = z.strictObject({
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  needs_help: z.boolean().default(false),
});

/** One line for the release history: what the owner asked for. */
function describeRequest(request: EditRequest, sourceName?: string): string {
  if (request.kind === "ask") return `Owner request: ${request.instruction}`;
  if (request.kind === "add_source") return `Owner added ${sourceName ?? request.source_id}${request.instruction ? `: ${request.instruction}` : ""}`;
  const what = [request.preset && request.preset.replace(/_/g, " "), request.instruction].filter(Boolean).join("; ");
  return `Owner tuned ${request.section_id}: ${what}`;
}

export interface ServiceOptions {
  /** Generates a studio course from its sources (the Worker passes src/generate's; tests a fake). */
  builder?: CourseBuilder;
  /** Turns an owner's request into proposed changes (the Worker passes src/edit's; tests canned models). */
  editor?: CourseEditor;
  /** Writes a learner's personal repair lesson (the Worker passes src/coach's; tests canned models). */
  repairer?: CoachRepairer;
  /** A studio course's owner-key settings (ignored for built-in courses, which use `models`). */
  ownerModels?: OwnerModelSettings;
  /**
   * The course this object holds: a built-in definition, or "studio" for a course created in the studio,
   * whose definition is in this object's storage. Default: the featured course (Node tools and tests).
   */
  course?: CourseDefinition | "studio";
  /** Studio courses report title, status and membership changes here. */
  directory?: DirectoryLink;
  now?: () => string;
  newId?: () => string;
  /** Whether a model is configured; without one, runs use the reference stand-ins. */
  agentsAvailable?: boolean;
  /** This course's models. Default: the process's (Node); the Worker always passes the course's own. */
  models?: ModelProvider;
  guard?: Guard;
  embedder?: Embedder;
}

const summarize = (r: ReleaseInfo): ReleaseSummary => ({
  version: r.version,
  parent: r.parent,
  status: r.status,
  tier: r.tier,
  bump: r.bump,
  changes: r.changes.map(describeChange),
  ...(r.rationale && { rationale: r.rationale }),
  ...(r.approval && { approval: r.approval }),
  ...(r.measurement && { measurement: r.measurement }),
  ...(r.decision && { decision: r.decision }),
  ...(r.promoted_to && { promoted_to: r.promoted_to }),
  ...(r.released_from && { released_from: r.released_from }),
  ...(r.trial_source && { trial_source: r.trial_source }),
  ...(r.pending && { pending: r.pending }),
  created_at: r.created_at,
});

/** Repair runs never reach the Learner Assistant; a stand-in keeps a reference run from creating any model. */
const NO_ASSISTANT = {
  invoke: async () => {
    throw new Error("The Learner Assistant isn't part of repair runs");
  },
};

export class CourseService {
  readonly releases: SqlReleaseStore;
  readonly events: SqlEventLog;
  readonly profiles: SqlProfiles;
  /** A studio course's members and their roles. Built-in courses use global roles instead. */
  readonly members: SqlMembers;
  private readonly sources: SqlSources;
  private readonly meta: SqlMeta;
  private readonly saver: PersistentMemorySaver;
  private readonly now: () => string;
  private readonly newId: () => string;
  /** A built-in course's definition; undefined for a studio course (see definition()). */
  private readonly fixed?: CourseDefinition;
  private compiled?: Course;

  constructor(
    sql: Sql,
    private readonly options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    if (options.course !== "studio") this.fixed = options.course ?? builtInCourse(FEATURED_COURSE)!;
    this.meta = new SqlMeta(sql);
    // A studio course has no release until it's published; a built-in one starts from its v1.0.0.
    this.releases = new SqlReleaseStore(sql, this.fixed && this.startingSnapshot(this.scenarioOf(this.scenario())), this.now);
    this.events = new SqlEventLog(sql);
    this.profiles = new SqlProfiles(sql);
    this.members = new SqlMembers(sql);
    this.sources = new SqlSources(sql);
    this.saver = new PersistentMemorySaver(new SqlThreadStore(sql));
    // Builds and runs live in this instance's memory, so one still marked running at start was cut off by a restart.
    if (this.record()?.status === "building") this.endBuild("failed", { problems: ["The build was interrupted (the server restarted); build again"] });
    if (this.run()?.status === "running") this.recoverInterruptedRun();
    const edit = this.editState();
    if (edit?.status === "running") this.meta.set("edit", { ...edit, status: "failed", problems: ["The server restarted while this was being prepared; ask again"] });
  }

  /**
   * Ends a run a restart cut off, so it can't block new runs and reset forever. Where it stopped decides
   * what's left: an answer to an approval that never took effect is asked for again (the graph's
   * checkpoint is still at the interrupt); a trial on real learners keeps collecting answers; a simulated
   * trial that was never measured is reverted; anything else ends in an error, and the run can start again.
   */
  private recoverInterruptedRun() {
    const run = this.run()!;
    const at = this.now();
    if (run.approval && !this.releases.get(run.approval.version)) {
      run.status = "awaiting_approval";
      run.steps.push({
        node: "approve",
        actor: "human",
        title: `Waiting for approval of ${run.approval.version}`,
        detail: "The server restarted before the answer took effect; answer again.",
        status: "waiting",
        at,
      });
    } else {
      for (const release of this.releases.summaries()) {
        if (release.status !== "trial" || release.trial_source === "real") continue;
        revert(this.releases, release.version);
        this.releases.update(release.version, { decision: { verdict: "revert", reasons: ["The server restarted before this trial was measured."] } });
      }
      if (this.openTrial()) {
        run.status = "trial_running";
      } else {
        run.status = "error";
        run.error = "The server restarted during this run; start it again";
      }
    }
    this.meta.set("run", run);
  }

  // ─── Course and releases ──────────────────────────────────────────

  /** The current scenario, or "" for a course without simulated learners. */
  scenario(): string {
    const scenarios = this.scenarios();
    return this.meta.get<string>("scenario") ?? this.fixed?.defaultScenario ?? scenarios[0]?.id ?? "";
  }

  private scenarios(): readonly Scenario[] {
    return this.fixed?.scenarios ?? [];
  }

  /** The course's definition: built in, or for a studio course its published v1.0.0. */
  private definition(): CourseDefinition {
    if (this.fixed) return this.fixed;
    const first = this.releases.first();
    if (!first) throw new NotPublished();
    return { id: this.record()?.id ?? first.snapshot.course_id, base: first.snapshot, scenarios: [], exemplars: [] };
  }

  /** Whether learners can take this course: it has a live release. */
  published(): boolean {
    return this.releases.first() !== undefined;
  }

  private requirePublished() {
    if (!this.published()) throw new NotPublished();
  }

  /** The course as v1.0.0 defines it (lessons, misconceptions), validated once. */
  course(): Course {
    this.compiled ??= courseFromSnapshot(this.definition().base);
    return this.compiled;
  }

  /** One of this course's scenarios; undefined for "" (none). */
  private scenarioOf(id: string): Scenario | undefined {
    if (!id) return undefined;
    const scenario = this.scenarios().find((s) => s.id === id);
    if (!scenario) throw new Error(`Unknown scenario "${id}". Available: ${this.scenarios().map((s) => s.id).join(", ") || "none"}`);
    return scenario;
  }

  /** v1.0.0 as a scenario publishes it (its faults in the prerequisite graph), or the course's own. */
  private startingSnapshot(scenario: Scenario | undefined): CourseSnapshot {
    const base = this.definition().base;
    return scenario ? scenarioSnapshot(scenario, this.course(), base) : structuredClone(base);
  }

  run(): RunState | undefined {
    return this.meta.get<RunState>("run");
  }

  overview() {
    return {
      course: this.courseInfo(),
      scenario: this.scenario(),
      scenarios: this.scenarios().map((s) => ({ id: s.id, title: s.title, description: s.description })),
      live: this.published() ? this.releases.live().version : null,
      releases: this.releases.summaries().map(summarize),
      run: this.run(),
      trial: this.trial(),
      agentsAvailable: this.agentsAvailable(),
      build: this.buildState() ?? null,
      edit: this.editState() ?? null,
    };
  }

  /** The release learners are served: live, or for half of them the trial while one runs on real learners. */
  servedRelease(learner: string): Release {
    this.requirePublished();
    const trial = this.openTrial();
    return trial && armOf(learner, trial.version) === "treatment" ? trial : this.releases.live();
  }

  myRelease(learner: string): ServedRelease {
    this.requirePublished();
    const trial = this.openTrial();
    if (!trial) return { version: this.releases.live().version };
    const arm = armOf(learner, trial.version);
    return { version: arm === "treatment" ? trial.version : this.releases.live().version, arm };
  }

  /** The full content of a release (default: the live one). */
  snapshot(version?: string): CourseSnapshot {
    this.requirePublished();
    const release = version ? this.releases.get(version) : this.releases.live();
    if (!release) throw new Error(`No release ${version}`);
    return release.snapshot;
  }

  /** Starts over from a scenario's v1.0.0 (or the course's own, without scenarios): releases, learner history and any run are cleared. */
  reset(scenarioId: string) {
    if (this.run()?.status === "running") throw new Error("A run is in progress; reset once it finishes");
    this.requirePublished();
    const scenario = this.scenarios().length > 0 ? this.scenarioOf(scenarioId) : undefined;
    this.meta.set("scenario", scenario?.id ?? "");
    this.meta.set("run", null);
    this.releases.reset(this.startingSnapshot(scenario), this.now);
    this.events.clear();
    this.profiles.clearStates();
  }

  // ─── Learners ─────────────────────────────────────────────────────

  /** This learner's graded quizzes on `lessonId`, oldest first, on any release. */
  private answersTo(learner: string, lessonId: string): LearnerEvent[] {
    return this.events.forLearner(learner).filter((e) => e.kind === "answer" && e.lesson === lessonId);
  }

  /**
   * The draw for a learner's next attempt on a release: seeded by (learner, lesson, attempt, release), and
   * preferring items they haven't seen, so the server can recompute it at submit without storing it.
   */
  private draw(learner: string, release: Release, lessonId: string) {
    const course = courseFromSnapshot(release.snapshot);
    const lesson = course.getLesson(lessonId);
    if (!lesson) throw new Error(`No lesson "${lessonId}" in ${release.version}`);
    const previous = this.answersTo(learner, lessonId);
    const attempt = previous.length + 1;
    // Answers recorded before exams were drawn have no item_ids, but every one lists its graded items.
    const seen = [
      // Questions the study coach showed count as seen, before the learner's own attempts.
      ...(this.meta.get<CoachState>(`coach:${learner}`)?.seen ?? []),
      ...previous.flatMap((e) => {
        const d = e.data as { item_ids?: string[]; items?: { item_id: string }[] };
        return d.item_ids ?? d.items?.map((i) => i.item_id) ?? [];
      }),
    ];
    const items = drawExam(lesson, course.objectives, { seen, seed: examSeed(learner, lessonId, attempt, release.version) });
    return { lesson, attempt, items };
  }

  /** The questions this learner's next attempt at a lesson shows, on the release they are served. */
  exam(learner: string, lessonId: string): Exam {
    const release = this.servedRelease(learner);
    const { attempt, items } = this.draw(learner, release, lessonId);
    return { release: release.version, lesson: lessonId, attempt, items };
  }

  /**
   * Grades a quiz on the release this learner is served, records it, and returns their next steps.
   * `item_ids` are the questions exam() drew, in the order answered; they must match the draw the server
   * recomputes. They may be left out only for a lesson without an exam config (the whole quiz, in order).
   */
  submitQuiz(learner: string, lessonId: string, answers: Response[], certainty: Certainty[], session?: string, item_ids?: string[]): QuizResult {
    if (!Array.isArray(answers) || !Array.isArray(certainty)) throw new Error("Send answers and certainty as lists");
    if (item_ids !== undefined && !(Array.isArray(item_ids) && item_ids.every((id) => typeof id === "string"))) throw new Error("item_ids must be a list of question ids");
    if (certainty.some((c) => c !== 1 && c !== 2 && c !== 3)) throw new Error("Certainty is 1, 2 or 3");
    const live = this.servedRelease(learner);
    const { lesson, attempt, items: drawn } = this.draw(learner, live, lessonId);
    const expected = drawn.map((item) => item.id);
    if (item_ids === undefined && lesson.exam) {
      throw new Error(`The exam for "${lessonId}" is drawn per attempt: send the item_ids exam() returned`);
    }
    if (item_ids !== undefined && (item_ids.length !== expected.length || item_ids.some((id, i) => id !== expected[i]))) {
      throw new Error(`These aren't the questions drawn for this attempt at "${lessonId}" on ${live.version}; load the exam again`);
    }
    if (answers.length !== drawn.length) throw new Error(`Expected ${drawn.length} answers, got ${answers.length}`);
    if (certainty.length !== drawn.length) throw new Error(`Expected ${drawn.length} certainty ratings, got ${certainty.length}`);

    // Short answers arrive as plain text. Without a calibrated grader they are kept for a human to review, unscored.
    const responses = answers.map((answer, i) =>
      drawn[i]!.type === "short_answer" && typeof answer === "string"
        ? { text: answer, criteria: [], detectors: [], needs_review: true }
        : answer,
    );
    const { grades, passed } = gradeAttempt(lesson, { learner_id: 0, lesson_id: lessonId, item_ids: expected, answers: responses, certainty, attempt });
    const items = drawn.map((item, i) => ({ item_id: item.id, pilot: item.pilot, grade: gradeItem(item, responses[i]!, lessonId) }));
    const score = grades.reduce((sum, g) => sum + g.score, 0) / Math.max(1, grades.length);
    const live_interventions = liveInterventions(live.snapshot);
    const steps = nextSteps(lessonId, grades, passed, live_interventions, liveObjectives(live.snapshot));
    const shown = new Set(steps.flatMap((s) => (s.kind === "intervention" ? [s.block_id] : [])));

    const at = this.now();
    this.events.append({ learner, kind: "answer", lesson: lessonId, release: live.version, data: { item_ids: expected, responses, certainty, items, passed, score, attempt, session }, at });
    this.events.append({ learner, kind: "path", lesson: lessonId, release: live.version, data: { steps, session }, at });
    this.refreshLearner(learner, at);

    return {
      release: live.version,
      passed,
      score,
      items,
      steps,
      interventions: live_interventions.filter((i) => shown.has(i.block_id)),
      mastery: this.progress(learner).find((p) => p.lesson === lessonId)?.mastery ?? 0,
    };
  }

  /**
   * A learner's answer to a check block (practice after a section) on the release they are served: the
   * feedback for the option picked, recorded as evidence. Checks are never scored.
   */
  answerCheck(learner: string, blockId: string, option: number, session?: string): CheckResult {
    const release = this.servedRelease(learner);
    let found: { lesson: string; block: CheckBlock } | undefined;
    for (const lesson of release.snapshot.lessons.filter((l) => !l.archived)) {
      for (const section of lesson.sections.filter((x) => !x.archived)) {
        for (const block of section.blocks) {
          if (block.kind === "check" && block.id === blockId && !block.archived) found = { lesson: lesson.id, block };
        }
      }
    }
    if (!found) throw new Error(`No check "${blockId}" in v${release.version}`);
    const { lesson, block } = found;
    const chosen = Number.isInteger(option) ? block.check.options[option] : undefined;
    if (!chosen) throw new Error(`Check "${blockId}" has no option ${option}`);

    this.events.append({
      learner,
      kind: "check",
      lesson,
      release: release.version,
      data: {
        block_id: blockId,
        option,
        correct: chosen.correct,
        misconception: chosen.misconception,
        ...(block.objective && { objective: block.objective }),
        session,
      },
      at: this.now(),
    });
    return { correct: chosen.correct, feedback: chosen.feedback };
  }

  /**
   * Per lesson of the release this learner is served: attempts, latest result, BKT mastery over every
   * scored answer, beliefs shown last time, and (for lessons with objectives) the objectives missed last time.
   */
  progress(learner: string): LessonProgress[] {
    const answers = this.events.forLearner(learner).filter((e) => e.kind === "answer");
    const snapshot = this.servedRelease(learner).snapshot;
    const withObjectives = new Set((snapshot.objectives ?? []).map((o) => o.lesson));
    return snapshot.lessons.flatMap((lesson) => {
      const attempts = answers.filter((e) => e.lesson === lesson.id).map((e) => e.data as { items: ItemResult[]; passed: boolean });
      if (attempts.length === 0) return [];
      const scored = attempts.flatMap((a) => a.items.filter((i) => !i.pilot && !i.grade.needs_review).map((i) => i.grade.correct));
      const mastery = bktMastery(scored);
      const last = attempts.at(-1)!;
      return [
        {
          lesson: lesson.id,
          attempts: attempts.length,
          passed: last.passed,
          mastery,
          mastered: mastery >= MASTERY_THRESHOLD,
          beliefs: [...new Set(last.items.flatMap((i) => i.grade.errors.flatMap((e) => e.misconception ?? [])))],
          ...(withObjectives.has(lesson.id) && {
            missed_objectives: [
              ...new Set(last.items.flatMap((i) => (!i.pilot && !i.grade.needs_review && !i.grade.correct && i.grade.objective ? [i.grade.objective] : []))),
            ],
          }),
        },
      ];
    });
  }

  // ─── Sessions and activity ────────────────────────────────────────

  /** A connection opened: the start of (or a return to) a visit. */
  startSession(learner: string, session: string) {
    if (!this.published()) return; // an owner working on a draft isn't a visit
    this.events.append({ learner, kind: "session", lesson: null, release: this.releases.live().version, data: { event: "start", session }, at: this.now() });
  }

  /**
   * A connection closed. Its duration runs from its own start. If that start is gone (the learner deleted
   * their data while connected), nothing is recorded, so deleting can't be undone by closing the tab.
   */
  endSession(learner: string, session: string) {
    const start = this.events
      .forLearner(learner)
      .find((e) => e.kind === "session" && (e.data as { event: string; session: string }).event === "start" && (e.data as { session: string }).session === session);
    if (!start) return;
    const at = this.now();
    const duration_ms = Math.max(0, Date.parse(at) - Date.parse(start.at));
    this.events.append({ learner, kind: "session", lesson: null, release: this.releases.live().version, data: { event: "end", session, duration_ms }, at });
  }

  private readonly trackWindows = new Map<string, { start: number; count: number }>();

  /**
   * Records activity the browser reports for its own learner: time on a lesson, an intervention shown or
   * completed. Validated against the live release and rate-limited per connection.
   */
  track(learner: string, session: string, raw: unknown) {
    const parsed = TrackEventSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid activity event");
    const event = parsed.data;

    const now = Date.parse(this.now());
    const window = this.trackWindows.get(session);
    if (!window || now - window.start > 60_000) this.trackWindows.set(session, { start: now, count: 1 });
    else if (++window.count > TRACK_EVENTS_PER_MINUTE) throw new Error("Too many activity events; slow down");

    const live = this.servedRelease(learner);
    if (event.kind === "lesson") {
      if (!live.snapshot.lessons.some((l) => l.id === event.lesson && !l.archived)) throw new Error(`No lesson "${event.lesson}"`);
      this.events.append({ learner, kind: "lesson", lesson: event.lesson, release: live.version, data: { active_ms: event.active_ms, session }, at: this.now() });
      return;
    }
    const block = liveInterventions(live.snapshot).find((i) => i.block_id === event.block_id);
    if (!block) throw new Error(`No intervention "${event.block_id}" in v${live.version}`);
    this.events.append({
      learner,
      kind: "intervention",
      lesson: block.lesson,
      release: live.version,
      data: { event: event.event, block_id: event.block_id, misconception: block.intervention.targets, context: event.context, session },
      at: this.now(),
    });
  }

  /** Everything the learner's account shows on "My progress". */
  myProgress(learner: string) {
    const events = this.events.forLearner(learner);
    const course = this.course();
    const time = timePerLesson(events);
    const progress = this.progress(learner);
    const sessions = sessionsOf(events);
    const quizzes = quizHistory(events);
    return {
      totals: {
        active_ms: Object.values(time).reduce((a, b) => a + b, 0),
        sessions: sessions.length,
        quizzes: quizzes.length,
        mastered: progress.filter((p) => p.mastered).length,
        lessons: course.lessons.length,
      },
      lessons: course.lessons.map((lesson) => {
        const p = progress.find((x) => x.lesson === lesson.id);
        return {
          lesson: lesson.id,
          title: lesson.title,
          active_ms: time[lesson.id] ?? 0,
          attempts: p?.attempts ?? 0,
          passed: p?.passed ?? false,
          mastery: p?.mastery ?? 0,
          mastered: p?.mastered ?? false,
        };
      }),
      sessions: sessions.reverse().slice(0, 20),
      quizzes: quizzes.slice(0, 20),
      beliefs: beliefsOf(events, course.misconceptions),
      interventions: interventionsOf(events),
    };
  }

  /** Removes everything recorded about this learner, including their profile. Course releases are untouched. */
  deleteMyData(learner: string) {
    this.profiles.delete(learner);
    this.meta.set(`coach:${learner}`, null);
    return { deleted: this.events.deleteLearner(learner) };
  }

  /** Remembers who signed in (name and email as their verified token carries them), for instructors' views. */
  recordProfile(identity: Identity) {
    this.profiles.seen({ user_id: identity.userId, name: identity.name, email: identity.email, role: identity.role }, this.now());
  }

  // ─── Study coach: diagnose → repair the one thing that matters now → re-check ──

  private coach(learner: string): CoachState {
    return this.meta.get<CoachState>(`coach:${learner}`) ?? { fixed: [], seen: [], repairs_today: { date: "", count: 0 } };
  }

  private saveCoach(learner: string, state: CoachState) {
    this.meta.set(`coach:${learner}`, state);
  }

  private resolve(release: string, questions: readonly CoachQuestion[]) {
    const snapshot = this.releases.get(release)?.snapshot;
    if (!snapshot) throw new Error("That version of the course is gone; start again");
    return questions.map((q) => {
      const item = snapshot.lessons.find((l) => l.id === q.lesson)?.quiz.find((i) => i.id === q.item_id);
      if (!item) throw new Error("A question is no longer in the course; start again");
      return { lesson: q.lesson, item };
    });
  }

  /** What the coach page shows: the latest diagnosis and repair, with their questions. */
  coachState(learner: string) {
    this.requirePublished();
    const state = this.coach(learner);
    const resolve = (release: string, qs?: readonly CoachQuestion[]) => {
      try {
        return qs ? this.resolve(release, qs) : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      diagnosis: state.diagnosis && { ...state.diagnosis, questions: resolve(state.diagnosis.release, state.diagnosis.questions) ?? [] },
      repair: state.repair && { ...state.repair, recheck: resolve(state.repair.release, state.repair.recheck) },
      fixed: state.fixed,
      repairs_left: MAX_REPAIRS_PER_DAY - (state.repairs_today.date === this.now().slice(0, 10) ? state.repairs_today.count : 0),
      /** Whether the coach can write new lessons here (a studio course with a usable key). */
      writes: Boolean(this.options.repairer && this.record() && this.agentsAvailable()),
    };
  }

  /** Starts a short diagnostic on a lesson and the lessons it builds on. */
  startDiagnosis(learner: string, lessonId: unknown, note?: unknown) {
    if (typeof lessonId !== "string") throw new Error("Pick a lesson");
    if (note !== undefined && (typeof note !== "string" || note.length > 1000)) throw new Error("Keep the note under 1000 characters");
    const release = this.servedRelease(learner);
    const state = this.coach(learner);
    const answered = this.events.forLearner(learner).flatMap((e) => (e.kind === "answer" ? ((e.data as { item_ids?: string[] }).item_ids ?? []) : []));
    const questions = drawDiagnostic(release.snapshot, lessonId, {
      seen: [...state.seen, ...answered],
      seed: examSeed(learner, lessonId, "coach", state.seen.length, release.version),
    });
    if (questions.length === 0) throw new Error("This lesson has no questions to diagnose with");
    const trimmed = typeof note === "string" && note.trim() ? note.trim() : undefined;
    state.diagnosis = {
      id: this.newId(),
      lesson: lessonId,
      release: release.version,
      ...(trimmed && { note: trimmed }),
      started_at: this.now(),
      questions: questions.map((q) => ({ lesson: q.lesson, item_id: q.item.id })),
      status: "open",
    };
    this.saveCoach(learner, state);
    return this.coachState(learner);
  }

  /** Scores the diagnostic and says what to repair first. */
  submitDiagnosis(learner: string, id: unknown, answers: unknown) {
    const state = this.coach(learner);
    const d = state.diagnosis;
    if (!d || d.id !== id || d.status !== "open") throw new Error("This diagnosis is over; start a new one");
    if (!Array.isArray(answers)) throw new Error("Send the answers as a list");
    const questions = this.resolve(d.release, d.questions);
    const result = scoreDiagnostic(this.releases.get(d.release)!.snapshot, d.lesson, questions, answers as Response[]);
    state.diagnosis = { ...d, status: "done", result };
    state.seen = [...new Set([...state.seen, ...d.questions.map((q) => q.item_id)])];
    this.saveCoach(learner, state);
    this.events.append({
      learner,
      kind: "coach",
      lesson: d.lesson,
      release: d.release,
      data: { type: "diagnosis", priority: targetKey(result.priority), target: result.priority, score: result.score, gaps: result.gaps, misconceptions: result.misconceptions.map((m) => m.id) },
      at: this.now(),
    });
    return this.coachState(learner);
  }

  /**
   * Starts repairing a target from the latest diagnosis (default: its priority). With a model, a lesson
   * is written for this learner in the background (continueRepair); without one, the course's own help
   * for it is used. `again` tries the same target with the next approach.
   */
  beginRepair(learner: string, key?: unknown, again = false): { state: ReturnType<CourseService["coachState"]>; write: boolean } {
    const state = this.coach(learner);
    const d = state.diagnosis;
    if (!d?.result) throw new Error("Do a diagnosis first");
    if (state.repair?.status === "running") throw new Error("A lesson is already being written for you");
    const targets = [d.result.priority, ...d.result.next];
    const target = again && state.repair ? state.repair.target : key === undefined ? d.result.priority : targets.find((t) => targetKey(t) === key);
    if (!target) throw new Error("That isn't one of your diagnosis results");
    if (target.kind === "ready") throw new Error("Nothing to repair: take the exam");
    const attempt = again && state.repair && targetKey(state.repair.target) === targetKey(target) ? state.repair.attempt + 1 : 0;
    const release = this.servedRelease(learner);
    const base = { id: this.newId(), target, approach: approachFor(target, attempt), attempt, release: release.version, started_at: this.now() };

    const write = Boolean(this.options.repairer && this.record() && this.agentsAvailable());
    if (write) {
      const today = this.now().slice(0, 10);
      const used = state.repairs_today.date === today ? state.repairs_today.count : 0;
      if (used >= MAX_REPAIRS_PER_DAY) throw new Error(`That's ${MAX_REPAIRS_PER_DAY} personal lessons today; the course's own sections are still there`);
      state.repairs_today = { date: today, count: used + 1 };
      state.repair = { ...base, status: "running" };
    } else {
      // The course's own help: a live intervention for the misconception, or the section that teaches it.
      const intervention = target.kind === "misconception" ? liveInterventions(release.snapshot).find((i) => i.intervention.targets === target.id) : undefined;
      const section = sectionsFor(release.snapshot, target)[0];
      const fallback: NonNullable<CoachState["repair"]>["fallback"] = intervention
        ? { kind: "intervention", block_id: intervention.block_id }
        : { kind: "review", lesson: target.lesson, section_id: section ?? "" };
      state.repair = { ...base, status: "ready", fallback, finished_at: this.now(), recheck: this.recheckFor(state, release.snapshot, target) };
    }
    this.saveCoach(learner, state);
    return { state: this.coachState(learner), write };
  }

  private recheckFor(state: CoachState, snapshot: CourseSnapshot, target: Target): CoachQuestion[] {
    return recheckItems(snapshot, target, new Set(state.seen)).map((q) => ({ lesson: q.lesson, item_id: q.item.id }));
  }

  /** The long part of a repair: writes the learner's lesson with the owner's key; never throws. */
  async continueRepair(learner: string): Promise<void> {
    const state = this.coach(learner);
    const repair = state.repair;
    if (!repair || repair.status !== "running") return;
    const finish = (patch: Partial<NonNullable<CoachState["repair"]>>) => {
      const latest = this.coach(learner);
      if (latest.repair?.id !== repair.id) return;
      latest.repair = { ...latest.repair, ...patch, finished_at: this.now() };
      this.saveCoach(learner, latest);
    };
    try {
      const record = this.studio();
      const provider = await this.ownerProvider();
      const snapshot = this.releases.get(repair.release)!.snapshot;
      const wrong = (state.diagnosis?.result?.wrong ?? []).filter((w) => w.lesson === repair.target.lesson);
      const result = await this.options.repairer!(
        {
          course: { course_id: record.id, title: record.title, ...(record.language && { language: record.language }) },
          snapshot,
          sources: this.sources.all(),
          target: repair.target,
          approach: repair.approach,
          ...(state.diagnosis?.note && { note: state.diagnosis.note }),
          wrong,
        },
        provider.structured,
      );
      if (result.ok) finish({ status: "ready", lesson: result.repair, recheck: this.recheckFor(state, snapshot, repair.target) });
      else finish({ status: "failed", problems: result.problems.map((p) => this.redact(p)) });
    } catch (error) {
      finish({ status: "failed", problems: [this.redact(error instanceof Error ? error.message : String(error))] });
    }
  }

  /** Grades the re-check after a repair: fixed when every answer is right and the mix-up didn't show. */
  submitRecheck(learner: string, id: unknown, answers: unknown) {
    const state = this.coach(learner);
    const repair = state.repair;
    if (!repair || repair.id !== id || repair.status !== "ready" || !repair.recheck) throw new Error("There is nothing to check right now");
    if (!Array.isArray(answers) || answers.length !== repair.recheck.length) throw new Error(`Answer all ${repair.recheck.length} questions`);
    const questions = this.resolve(repair.release, repair.recheck);
    const grades = questions.map((q, i) => gradeItem(q.item, answers[i] as Response, q.lesson));
    const target = repair.target;
    const fixed = grades.every((g) => g.correct) && !(target.kind === "misconception" && grades.some((g) => g.errors.some((e) => e.misconception === target.id)));
    const key = targetKey(target);
    state.repair = { ...repair, status: fixed ? "fixed" : "not_yet" };
    state.seen = [...new Set([...state.seen, ...repair.recheck.map((q) => q.item_id)])];
    if (fixed && !state.fixed.includes(key)) state.fixed.push(key);
    this.saveCoach(learner, state);
    this.events.append({
      learner,
      kind: "coach",
      lesson: target.lesson,
      release: repair.release,
      data: { type: "recheck", target_key: key, target, approach: repair.approach, attempt: repair.attempt, fixed, wrote: Boolean(repair.lesson) },
      at: this.now(),
    });
    const remaining = [state.diagnosis?.result?.priority, ...(state.diagnosis?.result?.next ?? [])].filter(
      (t): t is Target => Boolean(t) && t!.kind !== "ready" && !state.fixed.includes(targetKey(t!)),
    );
    return { fixed, grades: grades.map((g) => ({ correct: g.correct })), next: remaining[0] ?? null, state: this.coachState(learner) };
  }

  /**
   * For owners and editors: what learners keep needing repaired, most learners first, and whether the
   * personal lessons worked. The way back from one learner's repair to a fix for everyone.
   */
  coachInsights() {
    this.requirePublished();
    const byKey = new Map<string, { target: Target; learners: Set<string>; repaired: number; fixed: number; approaches: Record<string, { tried: number; fixed: number }> }>();
    // Only coach events, by index: this grows with coach use, not with the whole event log.
    for (const e of this.events.ofKind("coach")) {
      const learner = e.learner;
      const d = e.data as { type: string; priority?: string; target?: Target; target_key?: string; approach?: string; fixed?: boolean };
      const key = d.type === "diagnosis" ? d.priority : d.target_key;
      if (!key || !d.target || d.target.kind === "ready") continue;
      const row = byKey.get(key) ?? { target: d.target, learners: new Set<string>(), repaired: 0, fixed: 0, approaches: {} };
      row.learners.add(learner);
      if (d.type === "recheck") {
        row.repaired++;
        if (d.fixed) row.fixed++;
        const a = (row.approaches[d.approach ?? "?"] ??= { tried: 0, fixed: 0 });
        a.tried++;
        if (d.fixed) a.fixed++;
      }
      byKey.set(key, row);
    }
    const live = this.releases.live().snapshot;
    return [...byKey]
      .map(([key, r]) => ({ key, target: r.target, label: this.targetLabel(live, r.target), learners: r.learners.size, repaired: r.repaired, fixed: r.fixed, approaches: r.approaches }))
      .sort((a, b) => b.learners - a.learners || b.repaired - a.repaired);
  }

  private targetLabel(snapshot: CourseSnapshot, t: Target): string {
    const lesson = snapshot.lessons.find((l) => l.id === t.lesson)?.title ?? t.lesson;
    if (t.kind === "misconception") return `Mix-up: "${snapshot.misconceptions.find((m) => m.id === t.id)?.belief ?? t.id}"`;
    if (t.kind === "objective") return (snapshot.objectives ?? []).find((o) => o.id === t.id)?.statement ?? t.id;
    if (t.kind === "gap") return `Gap in "${lesson}"`;
    return lesson;
  }

  // ─── Instructors ──────────────────────────────────────────────────

  /**
   * A learner's row in the instructors' list, recomputed from their own events when they submit a quiz
   * (the one thing that changes it), so the list reads one row per learner instead of every event.
   */
  private refreshLearner(learner: string, at: string) {
    this.profiles.touch(learner, at);
    const p = this.myProgress(learner);
    const open = p.beliefs.filter((b) => !b.cleared);
    const lastQuiz = p.quizzes[0];
    this.profiles.setState(learner, { needs_help: open.length > 0 || (lastQuiz !== undefined && !lastQuiz.passed), open_beliefs: open.map((b) => ({ id: b.id, belief: b.belief, lesson: b.lesson })) }, at);
  }

  /** Courses from before the list kept rows: fill them once from the event log. */
  private backfillLearners() {
    if (this.meta.get<boolean>("learner_state_v1")) return;
    for (const { learner, last_at } of this.events.learners()) {
      this.profiles.touch(learner, last_at);
      this.refreshLearner(learner, last_at);
    }
    this.meta.set("learner_state_v1", true);
  }

  /**
   * One page of learners for instructors, most recently active first (keyset cursor), with headline
   * numbers and the most widespread beliefs counted in SQL. Each row's progress is computed for that
   * page only, so the cost grows with the page size, not with the number of learners.
   */
  learners(input: unknown = {}) {
    const parsed = LearnersQuerySchema.safeParse(input ?? {});
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const { cursor, limit, needs_help } = parsed.data;
    this.backfillLearners();
    let after: { last_seen: string; user_id: string } | undefined;
    if (cursor) {
      const [last_seen, user_id] = cursor.split("|");
      if (!last_seen || !user_id) throw new Error("Bad cursor");
      after = { last_seen, user_id };
    }
    const page = this.profiles.page({ ...(after && { after }), limit: limit + 1, needsHelp: needs_help });
    const rows = page.slice(0, limit).map((profile) => {
      const p = this.myProgress(profile.user_id);
      return {
        user_id: profile.user_id,
        name: profile.name ?? null,
        email: profile.email ?? null,
        role: profile.role ?? "learner",
        last_active: profile.last_seen,
        sessions: p.totals.sessions,
        active_ms: p.totals.active_ms,
        quizzes: p.totals.quizzes,
        mastered: p.totals.mastered,
        lessons: p.totals.lessons,
        open_beliefs: profile.open_beliefs ?? [],
        /** Still showing a belief, or failed their latest quiz. */
        needs_help: profile.needs_help ?? false,
      };
    });
    const last = rows.at(-1);
    const week = new Date(Date.parse(this.now()) - 7 * 24 * 3_600_000).toISOString();
    const totals = this.profiles.totals(week);
    return {
      summary: { learners: totals.learners, active_this_week: totals.active, needs_help: totals.needs_help, common_beliefs: totals.common_beliefs },
      learners: rows,
      next_cursor: page.length > limit && last ? `${last.last_active}|${last.user_id}` : null,
    };
  }

  /** One learner in full: their progress, and their history as a timeline. */
  learnerDetail(userId: string) {
    const course = this.course();
    const profile = this.profiles.get(userId);
    return {
      profile: { user_id: userId, name: profile?.name ?? null, email: profile?.email ?? null, role: profile?.role ?? "learner" },
      progress: this.myProgress(userId),
      timeline: timelineOf(
        this.events.forLearner(userId),
        (id) => course.getLesson(id)?.title ?? id,
        (id) => course.getMisconception(id)?.belief ?? id,
      ),
    };
  }

  // ─── Repair runs ──────────────────────────────────────────────────

  private graph(run: RunState, provider: ModelProvider | undefined) {
    const scenario = this.scenarioOf(run.scenario);
    const real = run.source === "real";
    const harness: Harness = {
      store: this.releases,
      measurer: real ? new RealMeasurer(() => this.events.answers()) : new SimMeasurer(this.course(), scenario!),
      trialSource: real ? "real" : "simulated",
      now: this.now,
      mode: run.mode,
      approver: run.agents ? createApprover(createApproverModel(provider!)) : approveWithinCeiling,
      ...(this.options.guard && { guard: this.options.guard }),
      ...(this.options.embedder && { embedder: this.options.embedder }),
    };
    const models = run.agents
      ? graphModels(provider!)
      : { assistant: NO_ASSISTANT, ...referenceModels(real ? undefined : scenario, this.diagnosisData(run), this.releases, this.definition().exemplars) };
    return buildGraph(models, { harness, checkpointer: this.saver });
  }

  /** The models agent runs use: a built-in course's (the Worker's), or a studio course's owner key. */
  private async models(): Promise<ModelProvider> {
    if (this.fixed) return this.options.models ?? defaultModels();
    return this.ownerProvider();
  }

  private save(run: RunState, onUpdate?: (run: RunState) => void) {
    this.meta.set("run", run);
    onUpdate?.(run);
  }

  /** Streams the graph from `input`, recording a step per node, until it ends or pauses for approval. Never throws: failures end the run with status "error". */
  private async drive(run: RunState, input: Parameters<ReturnType<CourseService["graph"]>["stream"]>[0], onUpdate?: (run: RunState) => void) {
    const config = { configurable: { thread_id: run.thread_id }, recursionLimit: 40 };
    const trace = traceConfig({
      name: input instanceof Command ? "repair-run (resumed after approval)" : "repair-run",
      thread_id: run.thread_id,
      scenario: run.scenario,
      mode: run.mode,
      agents: run.agents,
      source: run.source ?? "simulated",
      release: this.releases.live().version,
    });
    try {
      const app = this.graph(run, run.agents ? await this.models() : undefined);
      for await (const chunk of await app.stream(input, { ...config, ...trace, streamMode: "updates" })) {
        for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
          const step = stepFor(node, (update ?? {}) as State, this.now());
          if (step) {
            run.steps.push(step);
            this.save(run, onUpdate);
          }
        }
      }
      const state = await app.getState(config);
      const pending = state.tasks.flatMap((t) => t.interrupts);
      if (pending.length > 0) {
        run.status = "awaiting_approval";
        run.approval = pending[0]!.value as ApprovalRequest;
        run.steps.push({ node: "approve", actor: "human", title: `Waiting for approval of ${run.approval.version}`, status: "waiting", at: this.now() });
      } else {
        run.status = (state.values as State).trial_pending ? "trial_running" : "done";
        delete run.approval;
      }
    } catch (error) {
      if (error instanceof NoExemplar) {
        // A reference run can diagnose but not write: not a failure, just as far as it can go.
        run.status = "done";
        run.steps.push({ node: "author", actor: "code", title: "Needs a model to write this", detail: error.message, status: "info", at: this.now() });
      } else {
        run.status = "error";
        run.error = this.redact(error instanceof Error ? error.message : String(error));
      }
    }
    await flushTraces();
    this.save(run, onUpdate);
    return run;
  }

  /** Runs the repair loop on the live release's learner data. */
  async startRun(options: RunOptions, onUpdate?: (run: RunState) => void): Promise<RunState> {
    return this.continueRun(this.beginRun(options, onUpdate), onUpdate);
  }

  /**
   * Checks a run can start and records it, synchronously, so a caller that runs the rest in the
   * background (the Worker) can still report "already running" to whoever asked.
   */
  beginRun(options: RunOptions, onUpdate?: (run: RunState) => void): RunState {
    const parsed = RunOptionsSchema.safeParse(options);
    if (!parsed.success) throw new Error(`Invalid run options: ${firstIssue(parsed.error)}`);
    const { mode, agents, source = "simulated" } = parsed.data;
    const current = this.run()?.status;
    if (current === "running") throw new Error("A run is already in progress");
    if (current === "awaiting_approval") throw new Error("The current run is waiting for approval; answer it or reset first");
    if (this.openTrial()) throw new Error("A trial is running on real learners; evaluate or stop it first");
    if (agents && !this.agentsAvailable()) throw new Error("No model is configured, so only reference runs are available");
    this.requirePublished();
    if (source === "simulated" && this.scenarios().length === 0) throw new Error("This course has no simulated learners; run on real learners");
    const run: RunState = {
      thread_id: this.newId(),
      scenario: this.scenario(),
      mode,
      agents,
      source,
      status: "running",
      steps: [],
      started_at: this.now(),
    };
    this.save(run, onUpdate);
    return run;
  }

  /** The long part of a run started with beginRun. */
  async continueRun(run: RunState, onUpdate?: (run: RunState) => void): Promise<RunState> {
    const performance_data = this.diagnosisData(run);
    if (performance_data.length === 0) {
      run.steps.push({
        node: "curator",
        actor: "code",
        title: `No quiz answers on v${this.releases.live().version} yet`,
        status: "info",
        detail: "Real-learner runs diagnose people's first attempts on the live release. Nothing to go on until someone takes a quiz.",
        at: this.now(),
      });
      run.status = "done";
      this.save(run, onUpdate);
      return run;
    }
    return this.drive(run, { input_type: "cron", performance_data }, onUpdate);
  }

  /**
   * What a run diagnoses: the release learners have now (not the scenario's starting point), from the
   * scenario's simulated learners or from real learners' first attempts on it.
   */
  private diagnosisData(run: RunState) {
    const live = this.releases.live();
    return run.source === "real"
      ? realPerformance(live.snapshot, live.version, this.events.answers())
      : releasePerformance(this.scenarioOf(run.scenario)!, live.snapshot, this.course());
  }

  // ─── Trials on real learners ──────────────────────────────────────

  private openTrial(): Release | undefined {
    const info = this.releases.summaries().find((r) => r.status === "trial" && r.trial_source === "real");
    return info && this.releases.get(info.version);
  }

  trial(): TrialStatus | null {
    const t = this.openTrial();
    if (!t) return null;
    return {
      version: t.version,
      parent: t.parent!,
      started_at: t.trial_started_at ?? t.created_at,
      changes: t.changes.map(describeChange),
      ...(t.pending && { pending: t.pending }),
    };
  }

  /**
   * Measures the open real trial from the answers so far. Still short of learners: records the counts.
   * Enough: applies the same keep-or-revert rule as a simulated trial, and the run that started it ends.
   */
  evaluateTrial(onUpdate?: (run: RunState) => void): { status: "none" } | { status: "pending"; pending: PendingMeasurement } | { status: "decided"; verdict: "keep" | "revert"; live: string } {
    const trial = this.openTrial();
    if (!trial) return { status: "none" };
    const since = trial.trial_started_at ?? trial.created_at;
    const result = measureReal(this.releases.live(), trial, this.events.answers(since), since);
    if (isPending(result)) {
      this.releases.update(trial.version, { pending: result });
      this.finishTrialRun(undefined, onUpdate);
      return { status: "pending", pending: result };
    }
    const decision = settleTrial(this.releases, trial.version, result);
    const live = this.releases.live().version;
    this.finishTrialRun(
      {
        node: "decide",
        actor: "code",
        title: decision.verdict === "keep" ? `Kept: ${live} is live` : `Reverted: ${live} stays live`,
        status: decision.verdict === "keep" ? "ok" : "rejected",
        detail: decision.reasons.join("\n"),
        at: this.now(),
      },
      onUpdate,
    );
    return { status: "decided", verdict: decision.verdict, live };
  }

  /** Ends the open real trial by hand: it's reverted and every learner goes back to the live release. */
  stopTrial(by: string, onUpdate?: (run: RunState) => void) {
    const trial = this.openTrial();
    if (!trial) throw new Error("No trial is running");
    revert(this.releases, trial.version);
    const reason = `Stopped by ${by} before it could be measured.`;
    this.releases.update(trial.version, { decision: { verdict: "revert", reasons: [reason] } });
    this.finishTrialRun({ node: "decide", actor: "human", title: `Stopped: ${this.releases.live().version} stays live`, status: "rejected", detail: reason, at: this.now() }, onUpdate);
  }

  /** The run that started a real trial: refreshed while the trial runs, ended with `step` once it's decided. */
  private finishTrialRun(step: RunStep | undefined, onUpdate?: (run: RunState) => void) {
    const run = this.run();
    if (run?.status !== "trial_running") return;
    if (step) {
      run.steps.push(step);
      run.status = "done";
    }
    this.save(run, onUpdate);
  }

  /** A human's answer to the pending approval; the run continues from where it paused. */
  async approve(response: ApprovalResponse, onUpdate?: (run: RunState) => void): Promise<RunState> {
    const answer = parseApproval(response);
    return this.continueApproval(this.beginApproval(onUpdate), answer, onUpdate);
  }

  /** Checks something is waiting for approval and claims it, synchronously, so a second answer is refused. */
  beginApproval(onUpdate?: (run: RunState) => void): RunState {
    const run = this.run();
    if (run?.status !== "awaiting_approval") throw new Error("Nothing is waiting for approval");
    run.status = "running";
    run.steps = run.steps.filter((s) => s.status !== "waiting");
    this.save(run, onUpdate);
    return run;
  }

  /** The long part of an approval claimed with beginApproval. */
  async continueApproval(run: RunState, response: ApprovalResponse, onUpdate?: (run: RunState) => void): Promise<RunState> {
    return this.drive(run, new Command({ resume: response }), onUpdate);
  }

  // ─── Studio courses ───────────────────────────────────────────────

  /** A studio course's record; undefined for a built-in course or one not initialised yet. */
  record(): StudioRecord | undefined {
    if (this.fixed) return undefined;
    const stored = this.meta.get<Omit<StudioRecord, "audience"> & { audience?: Audience }>("course");
    return stored && { ...stored, audience: stored.audience ?? "beginner" };
  }

  /** Whether this object holds a course: built in, or a studio course the directory initialised. */
  initialised(): boolean {
    return Boolean(this.fixed ?? this.record());
  }

  private studio(): StudioRecord {
    const record = this.record();
    if (!record) throw new Error(this.fixed ? "Built-in courses aren't edited in the studio" : "No such course");
    return record;
  }

  /** What every connection shows about the course itself. */
  courseInfo() {
    const record = this.record();
    if (!record) return { id: this.fixed?.id ?? "", title: this.fixed?.base.title ?? "", description: "", status: "published" as CourseStatus, featured: true };
    return { id: record.id, title: record.title, description: record.description, status: record.status, featured: false };
  }

  /** Sets up a new studio course: called once, by the directory, right after it recorded the course. */
  initialise(input: { id: string; owner: Person } & CourseDetailsInput) {
    if (this.fixed) throw new Error("Built-in courses can't be initialised");
    if (this.record()) throw new Error("This course already exists");
    if (!isStudioId(input.id)) throw new Error("Not a studio course id");
    const parsed = CourseDetailsSchema.safeParse({ title: input.title, description: input.description, audience: input.audience });
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const record: StudioRecord = { id: input.id, ...parsed.data, goal: "", language: "", status: "draft", owner: input.owner.userId, created_at: this.now() };
    this.meta.set("course", record);
    this.members.set({ user_id: input.owner.userId, role: "owner", name: input.owner.name, email: input.owner.email }, this.now());
    return record;
  }

  // ─── Members and invites (studio courses) ─────────────────────────

  /** Someone's role in this studio course, or null if they aren't a member (always null on a built-in course). */
  memberRole(userId: string): CourseRole | null {
    if (this.fixed) return null;
    return this.members.get(userId)?.role ?? null;
  }

  /** One page of members in joining order (50 by default, at most 200): a course can be shared with a whole class. */
  memberPage(input: unknown = {}) {
    this.studio();
    const parsed = PageQuerySchema.safeParse(input ?? {});
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const { cursor, limit } = parsed.data;
    const [joined_at, user_id] = cursor ? cursor.split("|") : [];
    if (cursor && (!joined_at || !user_id)) throw new Error("Bad cursor");
    const page = this.members.page({ ...(joined_at && user_id && { after: { joined_at, user_id } }), limit: limit + 1 });
    const members = page.slice(0, limit);
    const last = members.at(-1);
    return { members, total: this.members.count(), next_cursor: page.length > limit && last ? `${last.joined_at}|${last.user_id}` : null };
  }

  memberList(): Member[] {
    this.studio();
    return this.members.all();
  }

  /** The owner makes a member an editor or a learner. Ownership itself doesn't move. */
  async setMemberRole(userId: string, role: unknown) {
    const record = this.studio();
    if (role === "owner" || !(COURSE_ROLES as readonly unknown[]).includes(role)) throw new Error(`Members can be editors or learners, not "${String(role)}"`);
    const member = this.members.get(userId);
    if (!member) throw new Error("Not a member of this course");
    if (member.role === "owner") throw new Error("The owner's role can't be changed");
    this.members.set({ user_id: userId, role: role as CourseRole }, this.now());
    await this.report((d) => d.membershipChanged(record.id, userId, role as CourseRole));
    return this.members.get(userId)!;
  }

  /** The owner removes a member. Their learning history stays (they can delete it themselves, or rejoin). */
  async removeMember(userId: string) {
    const record = this.studio();
    const member = this.members.get(userId);
    if (!member) throw new Error("Not a member of this course");
    if (member.role === "owner") throw new Error("The owner can't be removed");
    this.members.delete(userId);
    await this.report((d) => d.membershipChanged(record.id, userId, null));
  }

  /** A member leaves the course. */
  async leave(userId: string) {
    const record = this.studio();
    if (this.members.get(userId)?.role === "owner") throw new Error("The owner can't leave their own course");
    this.members.delete(userId);
    await this.report((d) => d.membershipChanged(record.id, userId, null));
  }

  /** The invite link's token, if one is active. Only the owner sees it. */
  invite(): { token: string | null; created_at: string | null } {
    this.studio();
    const invite = this.meta.get<{ token: string; created_at: string }>("invite");
    return { token: invite?.token ?? null, created_at: invite?.created_at ?? null };
  }

  /** Makes a new invite token; the old link stops working. */
  rotateInvite() {
    this.studio();
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    this.meta.set("invite", { token, created_at: this.now() });
    return this.invite();
  }

  revokeInvite() {
    this.studio();
    this.meta.set("invite", null);
  }

  /**
   * Joins with an invite token: a new member becomes a learner; an existing member keeps their role.
   * The directory calls this (and records the membership itself), so it doesn't report back.
   */
  join(person: Person, token: unknown): { role: CourseRole } {
    this.studio();
    const invite = this.meta.get<{ token: string }>("invite");
    if (!invite || typeof token !== "string" || !sameText(token, invite.token)) throw new Error("This invite link is no longer valid");
    const current = this.members.get(person.userId)?.role;
    const role = current ?? "learner";
    this.members.set({ user_id: person.userId, role, name: person.name, email: person.email }, this.now());
    return { role };
  }

  /** What the owner's details form shows: title, description, goal, language and audience. */
  details(): Pick<StudioRecord, "title" | "description" | "goal" | "language" | "audience" | "status"> {
    const { title, description, goal, language, audience, status } = this.studio();
    return { title, description, goal, language, audience, status };
  }

  /** The owner changes the title, description, goal, language or audience (the next build writes for it). */
  async updateDetails(input: unknown) {
    const record = this.studio();
    const parsed = DetailsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const next = { ...record, ...parsed.data };
    this.meta.set("course", next);
    if (parsed.data.title !== undefined || parsed.data.description !== undefined) {
      await this.report((d) => d.courseUpdated(record.id, { title: next.title, description: next.description }));
    }
    return this.courseInfo();
  }

  // ─── Sources (studio courses) ─────────────────────────────────────

  /** Sources can change while a course is a draft or in review; a build reads them, and a published course cites them. */
  private editableSources(adding = false) {
    const record = this.studio();
    if (record.status === "building") throw new Error("Wait for the build to finish before changing sources");
    // New files can join a published course (an edit then adds what they cover); cited ones stay as they are.
    if (record.status === "published" && !adding) throw new Error("A published course keeps its sources: lessons cite them");
  }

  /** Sources the owner has hidden from learners, by id (kept in meta: existing objects already have the sources table). */
  private hiddenSources(): Set<string> {
    return new Set(this.meta.get<string[]>("hidden_sources") ?? []);
  }

  private summaryOf(id: string): OwnerSourceSummary {
    return this.sourceList().find((s) => s.id === id)!;
  }

  /** The files, without their text; `shared` is the owner's "learners can open" switch. */
  sourceList(): OwnerSourceSummary[] {
    this.studio();
    const hidden = this.hiddenSources();
    return this.sources.summaries().map((s) => ({ ...s, shared: !hidden.has(s.id) }));
  }

  /** The full sources, for a build. */
  sourceTexts(): Source[] {
    this.studio();
    return this.sources.all();
  }

  /** Checks one upload's pages against the limits; long pages are cut to MAX_PAGE_CHARS. */
  private pagesWithinLimits(pages: string[], already: { pages: number; chars: number }): string[] {
    const cut = pages.map((p) => p.slice(0, MAX_PAGE_CHARS));
    const chars = cut.reduce((sum, p) => sum + p.length, 0);
    if (chars > SOURCE_LIMITS.charsPerCall) throw new Error(`Send at most ${SOURCE_LIMITS.charsPerCall.toLocaleString("en")} characters at a time; add the rest with appendPages`);
    if (already.pages + cut.length > SOURCE_LIMITS.pagesPerSource) throw new Error(`A file can have at most ${SOURCE_LIMITS.pagesPerSource} pages`);
    if (this.sources.totalChars() + chars > SOURCE_LIMITS.chars) throw new Error(`A course's sources can hold at most ${SOURCE_LIMITS.chars.toLocaleString("en")} characters in all`);
    return cut;
  }

  /** Adds a file as page texts. Its id ("s1", "s2", …) is never reused, so a citation can't point at a different file. */
  addSource(input: unknown): SourceSummary {
    this.editableSources(true);
    const parsed = SourceUploadSchema.safeParse(input);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    if (this.sources.count() >= SOURCE_LIMITS.sources) throw new Error(`A course can have at most ${SOURCE_LIMITS.sources} sources`);
    const pages = this.pagesWithinLimits(parsed.data.pages, { pages: 0, chars: 0 });
    const seq = (this.meta.get<number>("source_seq") ?? 0) + 1;
    const source = SourceSchema.parse({ id: `s${seq}`, name: parsed.data.name, ...(parsed.data.role && { role: parsed.data.role }), pages });
    this.sources.put(source, seq);
    this.meta.set("source_seq", seq);
    return this.summaryOf(source.id);
  }

  /** Adds more pages to a source: how a file too big for one message arrives. */
  appendPages(id: unknown, pages: unknown): SourceSummary {
    this.editableSources(true);
    const source = typeof id === "string" ? this.sources.get(id) : undefined;
    if (!source) throw new Error(`No source "${String(id)}"`);
    const parsed = SourceUploadSchema.shape.pages.safeParse(pages);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const added = this.pagesWithinLimits(parsed.data, { pages: source.pages.length, chars: 0 });
    this.sources.put(SourceSchema.parse({ ...source, pages: [...source.pages, ...added] }), this.sources.seq(source.id)!);
    return this.summaryOf(source.id);
  }

  removeSource(id: unknown) {
    this.editableSources();
    if (typeof id !== "string" || !this.sources.get(id)) throw new Error(`No source "${String(id)}"`);
    this.sources.delete(id);
  }

  /** Sets what a file is for (null: let the build decide). */
  setSourceRole(id: unknown, role: unknown): SourceSummary {
    this.editableSources();
    const source = typeof id === "string" ? this.sources.get(id) : undefined;
    if (!source) throw new Error(`No source "${String(id)}"`);
    if (role !== null && !(SOURCE_ROLES as readonly unknown[]).includes(role)) throw new Error(`Unknown role "${String(role)}"`);
    const { role: _old, ...rest } = source;
    this.sources.put(SourceSchema.parse(role === null ? rest : { ...rest, role }), this.sources.seq(source.id)!);
    return this.summaryOf(source.id);
  }

  /**
   * The owner lets learners open a file from the lessons that cite it, or stops them. Allowed after
   * publishing too: it changes who may read a file, not what the lessons say.
   */
  setSourceShared(id: unknown, shared: unknown): OwnerSourceSummary {
    this.studio();
    if (typeof id !== "string" || !this.sources.get(id)) throw new Error(`No source "${String(id)}"`);
    if (typeof shared !== "boolean") throw new Error("shared is true or false");
    const hidden = this.hiddenSources();
    if (shared) hidden.delete(id);
    else hidden.add(id);
    this.meta.set("hidden_sources", [...hidden]);
    return this.summaryOf(id);
  }

  /** One page of a source, checked; `page` is 1-based. */
  private pageOf(source: Source, page: unknown): SourcePage {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > source.pages.length) {
      throw new Error(`"${source.name}" has pages 1 to ${source.pages.length}`);
    }
    return { source: { id: source.id, name: source.name, pages: source.pages.length }, page, text: source.pages[page - 1]! };
  }

  /** Any page of any of this course's sources, for the owner (draft or published). */
  ownerSourcePage(id: unknown, page: unknown): SourcePage {
    this.studio();
    const source = typeof id === "string" ? this.sources.get(id) : undefined;
    if (!source) throw new Error(`No source "${String(id)}"`);
    return this.pageOf(source, page);
  }

  // ─── Sources learners can open (published studio courses) ─────────

  /**
   * The files a learner may open from their lessons: those cited by a live block of the release they are
   * served, minus the ones the owner hid. Past exams and briefs never, even if a block somehow cites one:
   * they show what is assessed and may hold the answers.
   */
  citedSources(learner: string): CitedSource[] {
    if (this.fixed) return []; // built-in courses are written by hand, not from uploaded files
    const snapshot = this.servedRelease(learner).snapshot;
    const cited = new Set<string>();
    for (const lesson of snapshot.lessons.filter((l) => !l.archived)) {
      for (const section of lesson.sections.filter((s) => !s.archived)) {
        for (const block of section.blocks) {
          if (!block.archived && isTextBlock(block)) for (const c of block.cites ?? []) cited.add(c.source);
        }
      }
    }
    const hidden = this.hiddenSources();
    return this.sources
      .summaries()
      .filter((s) => cited.has(s.id) && !hidden.has(s.id) && !(s.role && NEVER_SHOWN.has(s.role)))
      .map((s) => ({ id: s.id, name: s.name, pages: s.pages }));
  }

  /** A page of a file the learner may open (see citedSources): any page of it, not only the cited ones. */
  sourcePage(learner: string, id: unknown, page: unknown): SourcePage {
    if (this.fixed) throw new Error("This course has no source files");
    if (typeof id !== "string" || !this.citedSources(learner).some((s) => s.id === id)) throw new Error("This file isn't shared with learners");
    return this.pageOf(this.sources.get(id)!, page);
  }

  // ─── The owner's model key (studio courses) ───────────────────────

  /** What the owner's settings page shows. Never the key. */
  modelSettings() {
    this.studio();
    const stored = this.meta.get<StoredModelKey>("model_key");
    const owner = this.options.ownerModels;
    return {
      hasKey: Boolean(stored),
      model: stored?.model ?? null,
      choices: [...(owner?.choices ?? [])],
      /** Whether the Worker can store keys at all (KEY_ENCRYPTION_SECRET is set). */
      keysAvailable: keysAvailable(owner?.secret),
      set_at: stored?.set_at ?? null,
    };
  }

  /** Stores the owner's API key, sealed, with the model to use. */
  async setModelKey(key: unknown, model: unknown) {
    const record = this.studio();
    const owner = this.options.ownerModels;
    if (!owner || !keysAvailable(owner.secret)) throw new Error("Model keys can't be stored: KEY_ENCRYPTION_SECRET isn't set on the Worker");
    const parsed = MODEL_KEY.safeParse(key);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    if (typeof model !== "string" || !owner.choices.includes(model)) throw new Error(`Pick one of these models: ${owner.choices.join(", ") || "none configured"}`);
    const sealed = await sealSecret(parsed.data, owner.secret, record.id);
    this.meta.set("model_key", { sealed, model, set_at: this.now() } satisfies StoredModelKey);
    return this.modelSettings();
  }

  clearModelKey() {
    this.studio();
    this.meta.set("model_key", null);
    return this.modelSettings();
  }

  /** Whether agent runs (and builds) can use a model. */
  agentsAvailable(): boolean {
    if (this.fixed) return this.options.agentsAvailable ?? false;
    const owner = this.options.ownerModels;
    return Boolean(owner && keysAvailable(owner.secret) && owner.config.baseURL && this.meta.get<StoredModelKey>("model_key"));
  }

  /** What stops builds from using a model, so the owner isn't told to add a key that is already there. */
  private whyNoModels(): string {
    const owner = this.options.ownerModels;
    if (!owner?.config.baseURL) return "No model endpoint is configured on the Worker (MODEL_BASE_URL)";
    if (!keysAvailable(owner.secret)) return "Model keys can't be used: KEY_ENCRYPTION_SECRET isn't set on the Worker";
    return "Set a model API key first";
  }

  /** Models with the owner's key, opened just for this use. */
  private async ownerProvider(): Promise<ModelProvider> {
    const record = this.studio();
    const owner = this.options.ownerModels;
    const stored = this.meta.get<StoredModelKey>("model_key");
    if (!stored) throw new Error("Set a model API key first");
    if (!owner?.config.baseURL) throw new Error("No model endpoint is configured on the Worker (MODEL_BASE_URL)");
    if (!owner.choices.includes(stored.model)) throw new Error(`${stored.model} is no longer offered; pick another model`);
    const apiKey = await openSecret(stored.sealed, owner.secret, record.id);
    this.secrets.add(apiKey);
    return new ModelProvider({ ...owner.config, apiKey, models: { reasoning: stored.model, fast: stored.model } });
  }

  /** Keys opened in this instance, so an error message that quotes one never reaches state. */
  private readonly secrets = new Set<string>();

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.replaceAll(secret, "[model key]");
    return out;
  }

  // ─── Lifecycle (studio courses): draft → building → review → published ──

  buildState(): BuildState | undefined {
    return this.fixed ? undefined : (this.meta.get<BuildState>("build") ?? undefined);
  }

  private setStatus(status: CourseStatus) {
    const record = this.studio();
    this.meta.set("course", { ...record, status });
    void this.report((d) => d.courseUpdated(record.id, { status }));
  }

  private endBuild(status: "done" | "failed", result: Pick<BuildState, "problems" | "warnings" | "model_calls">, onUpdate?: () => void) {
    const build = this.buildState();
    this.meta.set("build", { ...(build ?? { steps: [], started_at: this.now() }), ...result, status, finished_at: this.now() } satisfies BuildState);
    // A failed rebuild leaves the previous build (if any) in review.
    this.setStatus(status === "done" || this.meta.get<CourseSnapshot>("draft") ? "review" : "draft");
    onUpdate?.();
  }

  /**
   * Checks a build can start and records it, synchronously, so the caller hears why not at once; the
   * build itself (continueBuild) runs in the background. A draft or a built course in review can be
   * (re)built; a published one changes through releases instead.
   */
  beginBuild(onUpdate?: () => void): BuildState {
    const record = this.studio();
    if (record.status === "building") throw new Error("A build is already running");
    if (record.status === "published") throw new Error("This course is published; it changes through releases now, not rebuilds");
    if (this.sources.count() === 0) throw new Error("Add at least one source first");
    if (!this.options.builder) throw new Error("Course generation isn't available on this server yet");
    if (!this.agentsAvailable()) throw new Error(this.whyNoModels());
    const build: BuildState = { status: "running", steps: [], started_at: this.now() };
    this.meta.set("build", build);
    this.setStatus("building");
    onUpdate?.();
    return build;
  }

  /** The long part of a build: runs the generator with the owner's key; never throws. */
  async continueBuild(build: BuildState, onUpdate?: () => void): Promise<BuildState> {
    const record = this.studio();
    try {
      const provider = await this.ownerProvider();
      const input = {
        course_id: record.id,
        title: record.title,
        ...(record.goal && { goal: record.goal }),
        ...(record.description && { description: record.description }),
        ...(record.language && { language: record.language }),
        audience: record.audience,
        sources: this.sources.all(),
      };
      const result = await this.options.builder!(input, provider.structured, (step) => {
        build.steps.push({ ...step, ...(step.detail && { detail: this.redact(step.detail) }) });
        this.meta.set("build", build);
        onUpdate?.();
      });
      const report = { warnings: result.report.warnings, model_calls: result.report.model_calls };
      if (!result.ok) {
        this.endBuild("failed", { ...report, problems: result.problems }, onUpdate);
      } else {
        // Code sets what identifies the release; the generator only supplies content.
        const snapshot = { ...result.snapshot, course_id: record.id, version: "1.0.0" };
        courseFromSnapshot(snapshot); // throws if the course isn't valid
        this.setDraft(snapshot);
        this.endBuild("done", report, onUpdate);
      }
    } catch (error) {
      this.endBuild("failed", { problems: [this.redact(error instanceof Error ? error.message : String(error))] }, onUpdate);
    }
    return this.buildState()!;
  }

  /** The built course, for the owner to review before publishing. */
  draft(): CourseSnapshot {
    this.studio();
    const draft = this.meta.get<CourseSnapshot>("draft");
    if (!draft) throw new Error("Nothing has been built yet");
    return draft;
  }

  /** Makes the built course release 1.0.0, live: learners can take it from now on. */
  publish(): { live: string } {
    const record = this.studio();
    if (record.status !== "review") throw new Error(record.status === "published" ? "Already published" : "Build the course and review it first");
    if (this.published()) throw new Error("Already published");
    const snapshot = this.draft();
    courseFromSnapshot(snapshot);
    this.releases.add(initialRelease(snapshot, this.now()));
    this.compiled = undefined;
    this.setStatus("published");
    return { live: this.releases.live().version };
  }

  /** Each new draft gets a revision, so an edit computed on an older one isn't applied to it. */
  private setDraft(snapshot: CourseSnapshot) {
    this.meta.set("draft", snapshot);
    this.meta.set("draft_rev", (this.meta.get<number>("draft_rev") ?? 0) + 1);
  }

  // ─── Owner edits (studio courses): request → proposal → apply ─────

  editState(): EditState | undefined {
    return this.fixed ? undefined : (this.meta.get<EditState>("edit") ?? undefined);
  }

  /**
   * Checks an edit can start and records it; the work itself (continueEdit) runs in the background.
   * A built course in review is edited in place; a published one gets a new release when the owner applies.
   */
  beginEdit(input: unknown, by: string, onUpdate?: () => void): EditState {
    const record = this.studio();
    const parsed = EditRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const request = parsed.data as EditRequest;
    if (record.status === "building") throw new Error("Wait for the build to finish");
    if (record.status === "draft") throw new Error("Build the course first; then you can tune it");
    if (this.editState()?.status === "running") throw new Error("An edit is already being prepared");
    if (!this.options.editor) throw new Error("Editing isn't available on this server yet");
    if (!this.agentsAvailable()) throw new Error(this.whyNoModels());
    if (request.kind === "add_source" && !this.sources.get(request.source_id)) throw new Error(`No file "${request.source_id}"`);
    const base: EditState["base"] =
      record.status === "published" ? { kind: "release", version: this.releases.live().version } : { kind: "draft", rev: this.meta.get<number>("draft_rev") ?? 0 };
    const edit: EditState = { id: this.newId(), request, by, status: "running", steps: [], started_at: this.now(), base };
    this.meta.set("edit", edit);
    onUpdate?.();
    return edit;
  }

  /** The long part of an edit: runs the editor with the owner's key; never throws. */
  async continueEdit(edit: EditState, onUpdate?: () => void): Promise<EditState> {
    const record = this.studio();
    const save = (patch: Partial<EditState>) => {
      Object.assign(edit, patch);
      this.meta.set("edit", edit);
      onUpdate?.();
    };
    try {
      const provider = await this.ownerProvider();
      const snapshot = edit.base.kind === "release" ? this.releases.live().snapshot : this.draft();
      const context = {
        course: {
          course_id: record.id,
          title: record.title,
          ...(record.goal && { goal: record.goal }),
          ...(record.description && { description: record.description }),
          ...(record.language && { language: record.language }),
        },
        snapshot,
        sources: this.sources.all(),
      };
      const result = await this.options.editor!(edit.request, context, provider.structured, (step) => {
        edit.steps.push({ ...step, ...(step.detail && { detail: this.redact(step.detail) }) });
        this.meta.set("edit", edit);
        onUpdate?.();
      });
      const report = { warnings: result.warnings.map((w) => this.redact(w)), model_calls: result.model_calls, finished_at: this.now() };
      if (result.ok) save({ ...report, status: "ready", proposal: result.proposal });
      else save({ ...report, status: "failed", problems: result.problems.map((p) => this.redact(p)) });
    } catch (error) {
      save({ status: "failed", finished_at: this.now(), problems: [this.redact(error instanceof Error ? error.message : String(error))] });
    }
    return edit;
  }

  /**
   * Applies a ready proposal: to the draft in place, or as a new live release with the changes and their
   * exact inverse recorded (so it can be reverted like any release). Refused if the course moved on.
   */
  applyEdit(id: unknown, by: string): { applied_as: string } {
    const record = this.studio();
    const edit = this.editState();
    if (!edit || edit.id !== id || edit.status !== "ready" || !edit.proposal) throw new Error("There is no proposal to apply");
    const changes = edit.proposal.changes as Change[];
    let appliedAs: string;
    if (edit.base.kind === "draft") {
      if (record.status !== "review" || (this.meta.get<number>("draft_rev") ?? 0) !== edit.base.rev) {
        throw new Error("The course changed since this was proposed; ask again");
      }
      const next = applyChanges(this.draft(), changes);
      courseFromSnapshot(next);
      this.setDraft(next);
      appliedAs = "draft";
    } else {
      const live = this.releases.live();
      if (live.version !== edit.base.version) throw new Error(`v${live.version} went live since this was proposed; ask again`);
      if (this.openTrial()) throw new Error("A trial is running; finish it before applying an edit");
      if (this.run()?.status === "running") throw new Error("A repair run is in progress; apply this once it finishes");
      const bump = maxBump(changes.map((c) => semverBump(live.snapshot, c)));
      const version = bumpVersion(live.version, bump);
      const snapshot = { ...applyChanges(live.snapshot, changes), version };
      courseFromSnapshot(snapshot);
      const source = edit.request.kind === "add_source" ? this.sources.get(edit.request.source_id)?.name : undefined;
      this.releases.update(live.version, { status: "superseded" });
      this.releases.add({
        version,
        parent: live.version,
        status: "live",
        changes,
        inverse: invertChanges(live.snapshot, changes),
        tier: maxTier(changes.map((c) => riskTier(live.snapshot, c))),
        bump,
        snapshot,
        rationale: describeRequest(edit.request, source),
        // The owner reviewed the exact changes; an edit isn't a measurable fix, so it isn't trialled.
        approval: { approved: true, by: "human", note: `Applied by ${by}` },
        created_at: this.now(),
      });
      appliedAs = version;
    }
    this.meta.set("edit", { ...edit, status: "applied", applied_as: appliedAs, finished_at: this.now() } satisfies EditState);
    return { applied_as: appliedAs };
  }

  /**
   * Undoes the live release by releasing its recorded inverse as a new version (history is never
   * rewritten). Works for any release built on a parent: an applied edit, or a kept repair.
   */
  undoRelease(version: unknown, by: string): { live: string } {
    this.requirePublished();
    const live = this.releases.live();
    if (live.version !== version) throw new Error(`Only the live release (v${live.version}) can be undone`);
    if (!live.parent || live.inverse.length === 0) throw new Error("The first release can't be undone");
    if (this.openTrial()) throw new Error("A trial is running; finish it first");
    if (this.run()?.status === "running") throw new Error("A repair run is in progress; undo once it finishes");
    const changes = live.inverse;
    const bump = maxBump(changes.map((c) => semverBump(live.snapshot, c)));
    const next = bumpVersion(live.version, bump);
    const snapshot = { ...applyChanges(live.snapshot, changes), version: next };
    courseFromSnapshot(snapshot);
    this.releases.update(live.version, { status: "superseded" });
    this.releases.add({
      version: next,
      parent: live.version,
      status: "live",
      changes,
      inverse: invertChanges(live.snapshot, changes),
      tier: maxTier(changes.map((c) => riskTier(live.snapshot, c))),
      bump,
      snapshot,
      rationale: `Undid v${live.version}`,
      approval: { approved: true, by: "human", note: `Undone by ${by}` },
      created_at: this.now(),
    });
    return { live: next };
  }

  discardEdit() {
    this.studio();
    const edit = this.editState();
    if (!edit || edit.status === "running") throw new Error(edit ? "Wait for the proposal first" : "There is no proposal");
    this.meta.set("edit", { ...edit, status: "discarded" } satisfies EditState);
  }

  /** Tells the directory; a failure there is logged, not thrown: this object stays the authority. */
  private async report(call: (directory: DirectoryLink) => Promise<void>) {
    if (!this.options.directory) return;
    try {
      await call(this.options.directory);
    } catch (error) {
      console.error("Couldn't update the directory:", error);
    }
  }
}
