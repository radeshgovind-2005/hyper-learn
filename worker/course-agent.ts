import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import { type Permission, permissionsOf, requirePermission } from "../src/app/access.js";
import { CourseService, type QuizResult } from "../src/app/service.js";
import type { Certainty, Response } from "../src/assessment/items.js";
import { type Identity, identityFrom } from "../src/auth/identity.js";
import { configureModels, modelConfigFromEnv } from "../src/models.js";
import { LANGSMITH_SETTINGS } from "../src/observability.js";
import type { ApprovalMode, ApprovalResponse } from "../src/nodes/release.js";
import type { Sql } from "../src/storage/sql.js";
import { workersAiEmbedder, workersAiGuard } from "./ai.js";

/** What every connected browser sees, kept in sync by the Agents SDK. */
export interface CourseAgentState {
  overview: ReturnType<CourseService["overview"]> | null;
}

/** Who is on a connection: verified by the Worker before the connection reached this object. */
interface ConnectionState {
  identity: Identity;
  connectedAt: string;
}

/**
 * One course, as a Durable Object: its releases, learner history, and repair runs live in the
 * object's SQLite. A thin wrapper; the logic is CourseService (src/app/service.ts), which tests run on Node.
 * Every method acts as the signed-in person on the calling connection, within their role.
 */
export class CourseAgent extends Agent<Env, CourseAgentState> {
  initialState: CourseAgentState = { overview: null };
  private service?: CourseService;

  private get app(): CourseService {
    if (!this.service) {
      const env = this.env as unknown as Record<string, string | undefined> & { AI?: Ai };
      // LangChain reads LangSmith settings from process.env; Worker vars and secrets arrive on env.
      for (const key of LANGSMITH_SETTINGS) if (env[key] && !process.env[key]) process.env[key] = env[key];
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

  /** Binds the connection to the person the Worker verified. A connection without one is closed. */
  override onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const identity = identityFrom(ctx.request);
    if (!identity) {
      connection.close(4001, "Unauthorized");
      return;
    }
    connection.setState({ identity, connectedAt: new Date().toISOString() });
    this.app.startSession(identity.userId, connection.id);
  }

  override onClose(connection: Connection<ConnectionState>) {
    const identity = connection.state?.identity;
    if (identity) this.app.endSession(identity.userId, connection.id);
  }

  private publish() {
    this.setState({ overview: this.app.overview() });
  }

  /** The person calling, if their role allows `permission`; otherwise the call fails with a readable message. */
  private actor(permission: Permission): Identity {
    const connection = getCurrentAgent().connection as Connection<ConnectionState> | undefined;
    return requirePermission(connection?.state?.identity, permission);
  }

  /** Who I am and what I may do, for the UI to show or hide controls. */
  @callable()
  me() {
    const identity = this.actor("learn");
    return { ...identity, permissions: permissionsOf(identity.role) };
  }

  @callable()
  overview() {
    this.actor("learn");
    return this.app.overview();
  }

  @callable()
  snapshot(version?: string) {
    this.actor("learn");
    return this.app.snapshot(version);
  }

  @callable()
  submitQuiz(lesson: string, answers: Response[], certainty: Certainty[]): QuizResult {
    const { userId } = this.actor("learn");
    return this.app.submitQuiz(userId, lesson, answers, certainty, this.connectionId());
  }

  /** Time on a lesson, or an intervention shown or completed, reported by the learner's own browser. */
  @callable()
  track(event: unknown) {
    const { userId } = this.actor("learn");
    this.app.track(userId, this.connectionId(), event);
  }

  @callable()
  myProgress() {
    const { userId } = this.actor("learn");
    return this.app.myProgress(userId);
  }

  /** Deletes everything recorded about the caller. Their Clerk account is managed in Clerk. */
  @callable()
  deleteMyData() {
    const { userId } = this.actor("learn");
    return this.app.deleteMyData(userId);
  }

  private connectionId(): string {
    return getCurrentAgent().connection?.id ?? "unknown";
  }

  @callable()
  progress() {
    const { userId } = this.actor("learn");
    return this.app.progress(userId);
  }

  @callable()
  reset(scenario: string) {
    this.actor("reset");
    this.app.reset(scenario);
    this.publish();
  }

  /**
   * Starts a repair run. Checks happen before returning, so the caller hears "already running";
   * the run itself continues in the background and reaches the UI through state updates.
   */
  @callable()
  startRun(mode: ApprovalMode, agents: boolean) {
    this.actor("repair");
    const run = this.app.beginRun({ mode, agents }, () => this.publish());
    this.background(() => this.app.continueRun(run, () => this.publish()));
  }

  /** Answers the pending approval. A second answer to the same approval is refused here, not lost. */
  @callable()
  approve(response: ApprovalResponse) {
    const { userId } = this.actor("repair");
    const run = this.app.beginApproval(() => this.publish());
    this.background(() => this.app.continueApproval(run, { ...response, note: response.note ?? `approved by ${userId}` }, () => this.publish()));
  }

  private background(work: () => Promise<unknown>) {
    void this.keepAliveWhile(work)
      .catch((error: unknown) => console.error("Background run failed:", error))
      .finally(() => this.publish());
  }
}
