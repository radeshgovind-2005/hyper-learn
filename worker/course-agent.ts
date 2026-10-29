import { Agent, callable } from "agents";
import { CourseService, type QuizResult } from "../src/app/service.js";
import type { Certainty, Response } from "../src/assessment/items.js";
import { configureModels, modelConfigFromEnv } from "../src/models.js";
import type { ApprovalMode, ApprovalResponse } from "../src/nodes/release.js";
import type { Sql } from "../src/storage/sql.js";
import { workersAiEmbedder, workersAiGuard } from "./ai.js";

/** Compares two secrets in time that doesn't depend on where they first differ. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** What every connected browser sees, kept in sync by the Agents SDK. */
export interface CourseAgentState {
  overview: ReturnType<CourseService["overview"]> | null;
}

/**
 * One course, as a Durable Object: its releases, learner history, and repair runs live in the
 * object's SQLite. A thin wrapper; the logic is CourseService (src/app/service.ts), which tests run on Node.
 */
export class CourseAgent extends Agent<Env, CourseAgentState> {
  initialState: CourseAgentState = { overview: null };
  private service?: CourseService;

  private get app(): CourseService {
    if (!this.service) {
      const env = this.env as unknown as Record<string, string | undefined> & { AI?: Ai };
      const settings = modelConfigFromEnv(env);
      configureModels(settings);
      const agentsAvailable = Boolean(env.MODEL_API_KEY && env.MODEL_BASE_URL);
      this.service = new CourseService(this.sql.bind(this) as unknown as Sql, {
        agentsAvailable,
        adminRequired: Boolean(env.ADMIN_TOKEN),
        ...(env.AI && { guard: workersAiGuard(env.AI), embedder: workersAiEmbedder(env.AI) }),
      });
    }
    return this.service;
  }

  override onStart() {
    this.publish();
  }

  private publish() {
    this.setState({ overview: this.app.overview() });
  }

  @callable()
  overview() {
    return this.app.overview();
  }

  @callable()
  snapshot(version?: string) {
    return this.app.snapshot(version);
  }

  @callable()
  submitQuiz(learner: string, lesson: string, answers: Response[], certainty: Certainty[]): QuizResult {
    return this.app.submitQuiz(learner, lesson, answers, certainty);
  }

  @callable()
  progress(learner: string) {
    return this.app.progress(learner);
  }

  /**
   * Changing the course (reset, runs, approvals) needs the ADMIN_TOKEN secret when one is set; learner
   * methods don't. Without a token (local dev) anyone connected can administer.
   */
  private requireAdmin(token: string | undefined) {
    const expected = (this.env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
    if (!expected) return;
    if (typeof token !== "string" || !sameSecret(token, expected)) throw new Error("Admin key required to change the course");
  }

  @callable()
  reset(scenario: string, token?: string) {
    this.requireAdmin(token);
    this.app.reset(scenario);
    this.publish();
  }

  /**
   * Starts a repair run. Checks happen before returning, so the caller hears "already running";
   * the run itself continues in the background and reaches the UI through state updates.
   */
  @callable()
  startRun(mode: ApprovalMode, agents: boolean, token?: string) {
    this.requireAdmin(token);
    const run = this.app.beginRun({ mode, agents }, () => this.publish());
    this.background(() => this.app.continueRun(run, () => this.publish()));
  }

  /** Answers the pending approval. A second answer to the same approval is refused here, not lost. */
  @callable()
  approve(response: ApprovalResponse, token?: string) {
    this.requireAdmin(token);
    const run = this.app.beginApproval(() => this.publish());
    this.background(() => this.app.continueApproval(run, response, () => this.publish()));
  }

  private background(work: () => Promise<unknown>) {
    void this.keepAliveWhile(work)
      .catch((error: unknown) => console.error("Background run failed:", error))
      .finally(() => this.publish());
  }
}
