import { Agent, callable } from "agents";
import { CourseService, type QuizResult } from "../src/app/service.js";
import type { Certainty, Response } from "../src/assessment/items.js";
import { configureModels, modelConfigFromEnv } from "../src/models.js";
import type { ApprovalMode, ApprovalResponse } from "../src/nodes/release.js";
import type { Sql } from "../src/storage/sql.js";
import { workersAiEmbedder, workersAiGuard } from "./ai.js";

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

  @callable()
  reset(scenario: string) {
    this.app.reset(scenario);
    this.publish();
  }

  /** Starts a repair run in the background; progress reaches the UI through state updates. */
  @callable()
  startRun(mode: ApprovalMode, agents: boolean) {
    void this.keepAliveWhile(() => this.app.startRun({ mode, agents }, () => this.publish()).finally(() => this.publish()));
  }

  @callable()
  approve(response: ApprovalResponse) {
    void this.keepAliveWhile(() => this.app.approve(response, () => this.publish()).finally(() => this.publish()));
  }
}
