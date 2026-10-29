import { Command } from "@langchain/langgraph";
import { bktMastery, MASTERY_THRESHOLD } from "../analytics/bkt.js";
import { beliefsOf, interventionsOf, quizHistory, sessionsOf, timePerLesson, TrackEventSchema } from "../analytics/learner.js";
import { gradeAttempt } from "../analytics/performance.js";
import { type Grade, gradeItem } from "../assessment/grade.js";
import type { Certainty, Response } from "../assessment/items.js";
import { getCourse } from "../course/bundle.js";
import { type CourseSnapshot, courseFromSnapshot, type LiveIntervention, liveInterventions } from "../course/compile.js";
import { buildGraph } from "../graph.js";
import type { Embedder, Guard } from "../guards/guards.js";
import { SimMeasurer } from "../measure/measure.js";
import { createApprover } from "../nodes/approver.js";
import type { ApprovalMode, ApprovalRequest, ApprovalResponse, Harness } from "../nodes/release.js";
import { nextSteps, type PathStep } from "../path/route.js";
import { describeChange } from "../releases/changes.js";
import type { Release } from "../releases/release.js";
import { releasePerformance, scenarioSnapshot } from "../simulation/index.js";
import { getScenario, SCENARIOS } from "../simulation/scenarios.js";
import type { State } from "../state.js";
import { PersistentMemorySaver } from "../storage/checkpointer.js";
import { type Sql, SqlEventLog, SqlMeta, SqlReleaseStore, SqlThreadStore } from "../storage/sql.js";
import { approveWithinCeiling, referenceModels } from "./reference.js";
import { flushTraces, traceConfig } from "../observability.js";
import { type RunStep, stepFor } from "./timeline.js";

// The application behind the UI, independent of where it runs: the Worker's Durable Object wraps it,
// tests run it on Node's SQLite. Everything it remembers lives in `sql`.

/** Most activity events one connection may report per minute. */
export const TRACK_EVENTS_PER_MINUTE = 60;

export interface RunState {
  thread_id: string;
  scenario: string;
  mode: ApprovalMode;
  /** true = the real agents on a model; false = the reference stand-ins (no model calls). */
  agents: boolean;
  status: "running" | "awaiting_approval" | "done" | "error";
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
  created_at: string;
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

export interface ServiceOptions {
  now?: () => string;
  newId?: () => string;
  /** Whether a model is configured; without one, runs use the reference stand-ins. */
  agentsAvailable?: boolean;
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
  created_at: r.created_at,
});

export class CourseService {
  readonly releases: SqlReleaseStore;
  readonly events: SqlEventLog;
  private readonly meta: SqlMeta;
  private readonly saver: PersistentMemorySaver;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    sql: Sql,
    private readonly options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.meta = new SqlMeta(sql);
    this.releases = new SqlReleaseStore(sql, scenarioSnapshot(getScenario(this.scenario())), this.now);
    this.events = new SqlEventLog(sql);
    this.saver = new PersistentMemorySaver(new SqlThreadStore(sql));
  }

  // ─── Course and releases ──────────────────────────────────────────

  scenario(): string {
    return this.meta.get<string>("scenario") ?? "dominant-misconception";
  }

  run(): RunState | undefined {
    return this.meta.get<RunState>("run");
  }

  overview() {
    return {
      scenario: this.scenario(),
      scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, description: s.description })),
      live: this.releases.live().version,
      releases: this.releases.all().map(summarize),
      run: this.run(),
      agentsAvailable: this.options.agentsAvailable ?? false,
    };
  }

  /** The full content of a release (default: the live one). */
  snapshot(version?: string): CourseSnapshot {
    const release = version ? this.releases.get(version) : this.releases.live();
    if (!release) throw new Error(`No release ${version}`);
    return release.snapshot;
  }

  /** Starts over from a scenario's v1.0.0: releases, learner history and any run are cleared. */
  reset(scenarioId: string) {
    if (this.run()?.status === "running") throw new Error("A run is in progress; reset once it finishes");
    const scenario = getScenario(scenarioId);
    this.meta.set("scenario", scenario.id);
    this.meta.set("run", null);
    this.releases.reset(scenarioSnapshot(scenario), this.now);
    this.events.clear();
  }

  // ─── Learners ─────────────────────────────────────────────────────

  /** Grades a quiz on the live release, records it, and returns the learner's next steps. */
  submitQuiz(learner: string, lessonId: string, answers: Response[], certainty: Certainty[], session?: string): QuizResult {
    const live = this.releases.live();
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
    this.events.append({ learner, kind: "answer", lesson: lessonId, release: live.version, data: { responses, certainty, items, passed, score, session }, at });
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
    return getCourse().lessons.flatMap((lesson) => {
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

  /** A connection closed. Its duration runs from its own start. */
  endSession(learner: string, session: string) {
    const start = this.events
      .forLearner(learner)
      .find((e) => e.kind === "session" && (e.data as { event: string; session: string }).event === "start" && (e.data as { session: string }).session === session);
    const at = this.now();
    const duration_ms = start ? Math.max(0, Date.parse(at) - Date.parse(start.at)) : 0;
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

    const live = this.releases.live();
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
    const course = getCourse();
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

  /** Removes everything recorded about this learner. Course releases are untouched. */
  deleteMyData(learner: string) {
    return { deleted: this.events.deleteLearner(learner) };
  }

  // ─── Repair runs ──────────────────────────────────────────────────

  private graph(run: RunState) {
    const scenario = getScenario(run.scenario);
    const harness: Harness = {
      store: this.releases,
      measurer: new SimMeasurer(getCourse(), scenario),
      mode: run.mode,
      approver: run.agents ? createApprover() : approveWithinCeiling,
      ...(this.options.guard && { guard: this.options.guard }),
      ...(this.options.embedder && { embedder: this.options.embedder }),
    };
    const models = run.agents ? {} : referenceModels(scenario, releasePerformance(scenario, this.releases.live().snapshot), this.releases);
    return buildGraph(models, { harness, checkpointer: this.saver });
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
      const pending = (await app.getState(config)).tasks.flatMap((t) => t.interrupts);
      if (pending.length > 0) {
        run.status = "awaiting_approval";
        run.approval = pending[0]!.value as ApprovalRequest;
        run.steps.push({ node: "approve", actor: "human", title: `Waiting for approval of ${run.approval.version}`, status: "waiting", at: this.now() });
      } else {
        run.status = "done";
        delete run.approval;
      }
    } catch (error) {
      run.status = "error";
      run.error = error instanceof Error ? error.message : String(error);
    }
    await flushTraces();
    this.save(run, onUpdate);
    return run;
  }

  /** Runs the repair loop on the live release's learner data. */
  async startRun(options: { mode: ApprovalMode; agents: boolean }, onUpdate?: (run: RunState) => void): Promise<RunState> {
    return this.continueRun(this.beginRun(options, onUpdate), onUpdate);
  }

  /**
   * Checks a run can start and records it, synchronously, so a caller that runs the rest in the
   * background (the Worker) can still report "already running" to whoever asked.
   */
  beginRun({ mode, agents }: { mode: ApprovalMode; agents: boolean }, onUpdate?: (run: RunState) => void): RunState {
    const current = this.run()?.status;
    if (current === "running") throw new Error("A run is already in progress");
    if (current === "awaiting_approval") throw new Error("The current run is waiting for approval; answer it or reset first");
    if (agents && !this.options.agentsAvailable) throw new Error("No model is configured, so only reference runs are available");
    const scenario = getScenario(this.scenario());
    const run: RunState = {
      thread_id: this.newId(),
      scenario: scenario.id,
      mode,
      agents,
      status: "running",
      steps: [],
      started_at: this.now(),
    };
    this.save(run, onUpdate);
    return run;
  }

  /** The long part of a run started with beginRun. */
  async continueRun(run: RunState, onUpdate?: (run: RunState) => void): Promise<RunState> {
    // Diagnose the release learners have now, not the scenario's starting point.
    const performance_data = releasePerformance(getScenario(run.scenario), this.releases.live().snapshot);
    return this.drive(run, { input_type: "cron", performance_data }, onUpdate);
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
