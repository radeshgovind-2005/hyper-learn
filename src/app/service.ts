import { Command } from "@langchain/langgraph";
import { bktMastery, MASTERY_THRESHOLD } from "../analytics/bkt.js";
import { beliefsOf, interventionsOf, quizHistory, sessionsOf, timelineOf, timePerLesson, TrackEventSchema } from "../analytics/learner.js";
import type { Identity } from "../auth/identity.js";
import { gradeAttempt } from "../analytics/performance.js";
import { type Grade, gradeItem } from "../assessment/grade.js";
import type { Certainty, Response } from "../assessment/items.js";
import { type CourseSnapshot, courseFromSnapshot, type LiveIntervention, liveInterventions } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import { buildGraph, graphModels } from "../graph.js";
import type { Embedder, Guard } from "../guards/guards.js";
import { SimMeasurer } from "../measure/measure.js";
import { type Arm, armOf, isPending, measureReal, type PendingMeasurement, RealMeasurer, realPerformance } from "../measure/real.js";
import { createApprover, createApproverModel } from "../nodes/approver.js";
import { type ApprovalMode, type ApprovalRequest, type ApprovalResponse, type Harness, settleTrial } from "../nodes/release.js";
import { nextSteps, type PathStep } from "../path/route.js";
import { describeChange } from "../releases/changes.js";
import { type Release, revert } from "../releases/release.js";
import { releasePerformance, scenarioSnapshot } from "../simulation/index.js";
import type { Scenario } from "../simulation/scenarios.js";
import { NoExemplar } from "../interventions/reference.js";
import { defaultModels, type ModelProvider } from "../models.js";
import type { State } from "../state.js";
import { PersistentMemorySaver } from "../storage/checkpointer.js";
import { type Sql, SqlEventLog, SqlMeta, SqlProfiles, SqlReleaseStore, SqlThreadStore } from "../storage/sql.js";
import { builtInCourse, type CourseDefinition, FEATURED_COURSE } from "./courses.js";
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
}

export interface RunOptions {
  mode: ApprovalMode;
  agents: boolean;
  /** Whose answers to diagnose and trial on. Default: simulated. */
  source?: DataSource;
}

export interface ServiceOptions {
  /** The course this object holds. Default: the featured course (Node tools and tests). */
  course?: CourseDefinition;
  now?: () => string;
  newId?: () => string;
  /** Whether a model is configured; without one, runs use the reference stand-ins. */
  agentsAvailable?: boolean;
  /** This course's models. Default: the process's (Node); the Worker always passes the course's own. */
  models?: ModelProvider;
  guard?: Guard;
  embedder?: Embedder;
}

const summarize = (r: Release): ReleaseSummary => ({
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
  private readonly meta: SqlMeta;
  private readonly saver: PersistentMemorySaver;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly definition: CourseDefinition;
  private compiled?: Course;

  constructor(
    sql: Sql,
    private readonly options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.definition = options.course ?? builtInCourse(FEATURED_COURSE)!;
    this.meta = new SqlMeta(sql);
    this.releases = new SqlReleaseStore(sql, this.startingSnapshot(this.scenarioOf(this.scenario())), this.now);
    this.events = new SqlEventLog(sql);
    this.profiles = new SqlProfiles(sql);
    this.saver = new PersistentMemorySaver(new SqlThreadStore(sql));
  }

  // ─── Course and releases ──────────────────────────────────────────

  /** The current scenario, or "" for a course without simulated learners. */
  scenario(): string {
    const { scenarios, defaultScenario } = this.definition;
    return this.meta.get<string>("scenario") ?? defaultScenario ?? scenarios[0]?.id ?? "";
  }

  /** The course as v1.0.0 defines it (lessons, misconceptions), validated once. */
  course(): Course {
    this.compiled ??= courseFromSnapshot(this.definition.base);
    return this.compiled;
  }

  /** One of this course's scenarios; undefined for "" (none). */
  private scenarioOf(id: string): Scenario | undefined {
    if (!id) return undefined;
    const scenario = this.definition.scenarios.find((s) => s.id === id);
    if (!scenario) throw new Error(`Unknown scenario "${id}". Available: ${this.definition.scenarios.map((s) => s.id).join(", ") || "none"}`);
    return scenario;
  }

  /** v1.0.0 as a scenario publishes it (its faults in the prerequisite graph), or the course's own. */
  private startingSnapshot(scenario: Scenario | undefined): CourseSnapshot {
    return scenario ? scenarioSnapshot(scenario, this.course(), this.definition.base) : structuredClone(this.definition.base);
  }

  run(): RunState | undefined {
    return this.meta.get<RunState>("run");
  }

  overview() {
    return {
      scenario: this.scenario(),
      scenarios: this.definition.scenarios.map((s) => ({ id: s.id, title: s.title, description: s.description })),
      live: this.releases.live().version,
      releases: this.releases.all().map(summarize),
      run: this.run(),
      trial: this.trial(),
      agentsAvailable: this.options.agentsAvailable ?? false,
    };
  }

  /** The release learners are served: live, or for half of them the trial while one runs on real learners. */
  servedRelease(learner: string): Release {
    const trial = this.openTrial();
    return trial && armOf(learner, trial.version) === "treatment" ? trial : this.releases.live();
  }

  myRelease(learner: string): ServedRelease {
    const trial = this.openTrial();
    if (!trial) return { version: this.releases.live().version };
    const arm = armOf(learner, trial.version);
    return { version: arm === "treatment" ? trial.version : this.releases.live().version, arm };
  }

  /** The full content of a release (default: the live one). */
  snapshot(version?: string): CourseSnapshot {
    const release = version ? this.releases.get(version) : this.releases.live();
    if (!release) throw new Error(`No release ${version}`);
    return release.snapshot;
  }

  /** Starts over from a scenario's v1.0.0 (or the course's own, without scenarios): releases, learner history and any run are cleared. */
  reset(scenarioId: string) {
    if (this.run()?.status === "running") throw new Error("A run is in progress; reset once it finishes");
    const scenario = this.definition.scenarios.length > 0 ? this.scenarioOf(scenarioId) : undefined;
    this.meta.set("scenario", scenario?.id ?? "");
    this.meta.set("run", null);
    this.releases.reset(this.startingSnapshot(scenario), this.now);
    this.events.clear();
  }

  // ─── Learners ─────────────────────────────────────────────────────

  /** Grades a quiz on the release this learner is served, records it, and returns their next steps. */
  submitQuiz(learner: string, lessonId: string, answers: Response[], certainty: Certainty[], session?: string): QuizResult {
    const live = this.servedRelease(learner);
    const course = courseFromSnapshot(live.snapshot);
    const lesson = course.getLesson(lessonId);
    if (!lesson) throw new Error(`No lesson "${lessonId}" in ${live.version}`);
    if (answers.length !== lesson.quiz.length) throw new Error(`Expected ${lesson.quiz.length} answers, got ${answers.length}`);

    // Short answers arrive as plain text. Without a calibrated grader they are kept for a human to review, unscored.
    const responses = answers.map((answer, i) =>
      lesson.quiz[i]!.type === "short_answer" && typeof answer === "string"
        ? { text: answer, criteria: [], detectors: [], needs_review: true }
        : answer,
    );
    const previous = this.events.forLearner(learner).filter((e) => e.kind === "answer" && e.lesson === lessonId).length;
    const { grades, passed } = gradeAttempt(lesson, { learner_id: 0, lesson_id: lessonId, answers: responses, certainty, attempt: previous + 1 });
    const items = lesson.quiz.map((item, i) => ({ item_id: item.id, pilot: item.pilot, grade: gradeItem(item, responses[i]!, lessonId) }));
    const score = grades.reduce((sum, g) => sum + g.score, 0) / Math.max(1, grades.length);
    const live_interventions = liveInterventions(live.snapshot);
    const steps = nextSteps(lessonId, grades, passed, live_interventions);
    const shown = new Set(steps.flatMap((s) => (s.kind === "intervention" ? [s.block_id] : [])));

    const at = this.now();
    this.events.append({ learner, kind: "answer", lesson: lessonId, release: live.version, data: { responses, certainty, items, passed, score, attempt: previous + 1, session }, at });
    this.events.append({ learner, kind: "path", lesson: lessonId, release: live.version, data: { steps, session }, at });

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

  /** Per lesson: attempts, latest result, BKT mastery over every scored answer, and beliefs shown last time. */
  progress(learner: string): LessonProgress[] {
    const answers = this.events.forLearner(learner).filter((e) => e.kind === "answer");
    return this.course().lessons.flatMap((lesson) => {
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
        },
      ];
    });
  }

  // ─── Sessions and activity ────────────────────────────────────────

  /** A connection opened: the start of (or a return to) a visit. */
  startSession(learner: string, session: string) {
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
    return { deleted: this.events.deleteLearner(learner) };
  }

  /** Remembers who signed in (name and email as their verified token carries them), for instructors' views. */
  recordProfile(identity: Identity) {
    this.profiles.seen({ user_id: identity.userId, name: identity.name, email: identity.email, role: identity.role }, this.now());
  }

  // ─── Instructors ──────────────────────────────────────────────────

  /** Every learner with a summary an instructor can scan: activity, mastery, and beliefs still showing. */
  learners() {
    const profiles = new Map(this.profiles.all().map((p) => [p.user_id, p] as const));
    const lastEvent = new Map(this.events.learners().map((l) => [l.learner, l.last_at] as const));
    const ids = [...new Set([...profiles.keys(), ...lastEvent.keys()])];
    const now = Date.parse(this.now());

    const rows = ids.map((id) => {
      const p = this.myProgress(id);
      const profile = profiles.get(id);
      const open = p.beliefs.filter((b) => !b.cleared);
      const lastQuiz = p.quizzes[0];
      const last_active = [profile?.last_seen, lastEvent.get(id)].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      return {
        user_id: id,
        name: profile?.name ?? null,
        email: profile?.email ?? null,
        role: profile?.role ?? "learner",
        last_active,
        sessions: p.totals.sessions,
        active_ms: p.totals.active_ms,
        quizzes: p.totals.quizzes,
        mastered: p.totals.mastered,
        lessons: p.totals.lessons,
        open_beliefs: open.map((b) => ({ id: b.id, belief: b.belief, lesson: b.lesson })),
        /** Still showing a belief, or failed their latest quiz. */
        needs_help: open.length > 0 || (lastQuiz !== undefined && !lastQuiz.passed),
      };
    });
    rows.sort((a, b) => (b.last_active ?? "").localeCompare(a.last_active ?? ""));

    const holders = new Map<string, { id: string; belief: string; learners: number }>();
    for (const row of rows) {
      for (const b of row.open_beliefs) {
        const entry = holders.get(b.id) ?? { id: b.id, belief: b.belief, learners: 0 };
        entry.learners++;
        holders.set(b.id, entry);
      }
    }
    const week = 7 * 24 * 3_600_000;
    return {
      summary: {
        learners: rows.length,
        active_this_week: rows.filter((r) => r.last_active && now - Date.parse(r.last_active) < week).length,
        needs_help: rows.filter((r) => r.needs_help).length,
        common_beliefs: [...holders.values()].sort((a, b) => b.learners - a.learners).slice(0, 5),
      },
      learners: rows,
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

  private graph(run: RunState) {
    const scenario = this.scenarioOf(run.scenario);
    const real = run.source === "real";
    const harness: Harness = {
      store: this.releases,
      measurer: real ? new RealMeasurer(() => this.events.answers()) : new SimMeasurer(this.course(), scenario!),
      trialSource: real ? "real" : "simulated",
      now: this.now,
      mode: run.mode,
      approver: run.agents ? createApprover(createApproverModel(this.models())) : approveWithinCeiling,
      ...(this.options.guard && { guard: this.options.guard }),
      ...(this.options.embedder && { embedder: this.options.embedder }),
    };
    const models = run.agents
      ? graphModels(this.models())
      : { assistant: NO_ASSISTANT, ...referenceModels(real ? undefined : scenario, this.diagnosisData(run), this.releases, this.definition.exemplars) };
    return buildGraph(models, { harness, checkpointer: this.saver });
  }

  private models(): ModelProvider {
    return this.options.models ?? defaultModels();
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
      const app = this.graph(run);
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
        run.error = error instanceof Error ? error.message : String(error);
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
  beginRun({ mode, agents, source = "simulated" }: RunOptions, onUpdate?: (run: RunState) => void): RunState {
    const current = this.run()?.status;
    if (current === "running") throw new Error("A run is already in progress");
    if (current === "awaiting_approval") throw new Error("The current run is waiting for approval; answer it or reset first");
    if (this.openTrial()) throw new Error("A trial is running on real learners; evaluate or stop it first");
    if (agents && !this.options.agentsAvailable) throw new Error("No model is configured, so only reference runs are available");
    if (source === "simulated" && this.definition.scenarios.length === 0) throw new Error("This course has no simulated learners; run on real learners");
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
    return this.releases.all().find((r) => r.status === "trial" && r.trial_source === "real");
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
    return this.continueApproval(this.beginApproval(onUpdate), response, onUpdate);
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
}
