import { Agent, type Connection, type ConnectionContext, callable, getAgentByName, getCurrentAgent } from "agents";
import { type Permission, permissionsOf, requirePermission } from "../src/app/access.js";
import { builtInCourse, DIRECTORY_NAME, isBuiltIn, isStudioId } from "../src/app/courses.js";
import { CourseService, type DataSource, type DirectoryLink, type QuizResult } from "../src/app/service.js";
import type { Certainty, Response } from "../src/assessment/items.js";
import { type Identity, identityFrom } from "../src/auth/identity.js";
import { checkRoleChange, setClerkRole } from "../src/auth/roles.js";
import { ModelProvider, modelConfigFromEnv } from "../src/models.js";
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
 * One course, as a Durable Object named by the course id: its releases, learner history, and repair runs
 * live in the object's SQLite. A thin wrapper; the logic is CourseService (src/app/service.ts), which tests run on Node.
 * Every method acts as the signed-in person on the calling connection, within their role.
 */
export class CourseAgent extends Agent<Env, CourseAgentState> {
  initialState: CourseAgentState = { overview: null };
  private service?: CourseService;

  /** Whether this object holds a course. The Worker refuses unknown names; this is the second check. */
  private known(): boolean {
    return isBuiltIn(this.name) || (isStudioId(this.name) && this.app.initialised());
  }

  private get app(): CourseService {
    if (!this.service) {
      const course = builtInCourse(this.name) ?? (isStudioId(this.name) ? "studio" : undefined);
      if (!course) throw new Error("No such course");
      const env = this.env as unknown as Record<string, string | undefined> & { AI?: Ai };
      // LangChain reads LangSmith settings from process.env; Worker vars and secrets arrive on env.
      for (const key of LANGSMITH_SETTINGS) if (env[key] && !process.env[key]) process.env[key] = env[key];
      const agentsAvailable = Boolean(env.MODEL_API_KEY && env.MODEL_BASE_URL);
      this.service = new CourseService(this.sql.bind(this) as unknown as Sql, {
        course,
        directory: this.directoryLink(),
        agentsAvailable,
        models: new ModelProvider(modelConfigFromEnv(env)),
        ...(env.AI && { guard: workersAiGuard(env.AI), embedder: workersAiEmbedder(env.AI) }),
      });
    }
    return this.service;
  }

  /** How often an open trial on real learners is re-measured, in seconds. */
  static readonly TRIAL_CHECK_INTERVAL = 3600;

  override async onStart() {
    if (!this.known()) return;
    this.publish();
    // Idempotent: one schedule however often the object wakes.
    await this.scheduleEvery(CourseAgent.TRIAL_CHECK_INTERVAL, "checkTrial");
  }

  /** The directory, over Durable Object RPC. */
  private directoryLink(): DirectoryLink {
    const directory = () => getAgentByName(this.env.DirectoryAgent, DIRECTORY_NAME);
    return {
      courseUpdated: async (id, patch) => (await directory()).courseUpdated(id, patch),
      membershipChanged: async (id, userId, role) => (await directory()).membershipChanged(id, userId, role),
    };
  }

  // ─── RPC only (not @callable): the directory ─────────────────────────

  /** Sets up a new studio course. The directory calls this once, right after recording the course. */
  async initialise(input: { id: string; title: string; description: string; owner: Identity }) {
    if (input?.id !== this.name) throw new Error("Course id doesn't match this object");
    const record = this.app.initialise(input);
    this.publish();
    await this.scheduleEvery(CourseAgent.TRIAL_CHECK_INTERVAL, "checkTrial");
    return { id: record.id };
  }

  /** Scheduled, not callable by clients: decides an open real trial once both arms have enough learners. */
  async checkTrial() {
    const result = this.app.evaluateTrial(() => this.publish());
    if (result.status !== "none") this.publish();
  }

  /** Binds the connection to the person the Worker verified. A connection without one is closed. */
  override onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    if (!this.known()) {
      connection.close(4004, "No such course");
      return;
    }
    const identity = identityFrom(ctx.request);
    if (!identity) {
      connection.close(4001, "Unauthorized");
      return;
    }
    connection.setState({ identity, connectedAt: new Date().toISOString() });
    this.app.recordProfile(identity);
    this.app.startSession(identity.userId, connection.id);
  }

  override onClose(connection: Connection<ConnectionState>) {
    const identity = connection.state?.identity;
    if (identity) this.app.endSession(identity.userId, connection.id);
  }

  /** State is the server's view; a browser can't overwrite what other people see. */
  override validateStateChange(_next: CourseAgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only");
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
    // Role changes need Clerk's secret key; without it, admins see roles but can't change them here.
    const rolesConfigured = Boolean((this.env as unknown as { CLERK_SECRET_KEY?: string }).CLERK_SECRET_KEY);
    return { ...identity, permissions: permissionsOf(identity.role), rolesConfigured };
  }

  /** Admins: changes someone else's role in Clerk. It applies when their browser next connects. */
  @callable()
  async setRole(userId: string, role: string) {
    const { userId: by } = this.actor("manage_roles");
    const next = checkRoleChange(by, userId, role);
    const secretKey = (this.env as unknown as { CLERK_SECRET_KEY?: string }).CLERK_SECRET_KEY;
    if (!secretKey) throw new Error("Role changes need CLERK_SECRET_KEY on the Worker; set roles in the Clerk dashboard meanwhile");
    await setClerkRole(secretKey, userId, next);
    this.app.profiles.setRole(userId, next);
    console.log(`Role of ${userId} set to ${next} by ${by}`);
    return { userId, role: next };
  }

  @callable()
  overview() {
    this.actor("learn");
    return this.app.overview();
  }

  @callable()
  snapshot(version?: string) {
    const { userId } = this.actor("learn");
    return this.app.snapshot(version ?? this.app.myRelease(userId).version);
  }

  /** The release the caller is served: during a trial on real learners, half of learners get the trial. */
  @callable()
  myRelease() {
    const { userId } = this.actor("learn");
    return this.app.myRelease(userId);
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

  /** Every learner, summarised for instructors. */
  @callable()
  learners() {
    this.actor("view_learners");
    return this.app.learners();
  }

  /** One learner's progress and timeline, for instructors. */
  @callable()
  learnerDetail(userId: string) {
    this.actor("view_learners");
    return this.app.learnerDetail(userId);
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
  startRun(mode: ApprovalMode, agents: boolean, source: DataSource = "simulated") {
    this.actor("repair");
    if (source !== "simulated" && source !== "real") throw new Error(`Unknown data source "${String(source)}"`);
    const run = this.app.beginRun({ mode, agents, source }, () => this.publish());
    this.background(() => this.app.continueRun(run, () => this.publish()));
  }

  /** Answers the pending approval. A second answer to the same approval is refused here, not lost. */
  @callable()
  approve(response: ApprovalResponse) {
    const { userId } = this.actor("repair");
    const run = this.app.beginApproval(() => this.publish());
    this.background(() => this.app.continueApproval(run, { ...response, note: response.note ?? `approved by ${userId}` }, () => this.publish()));
  }

  /** Measures the open real trial now instead of waiting for the hourly check. */
  @callable()
  evaluateTrial() {
    this.actor("repair");
    const result = this.app.evaluateTrial(() => this.publish());
    this.publish();
    return result;
  }

  /** Ends the open real trial without a measurement: reverted, everyone back on the live release. */
  @callable()
  stopTrial() {
    const { userId } = this.actor("repair");
    this.app.stopTrial(userId, () => this.publish());
    this.publish();
  }

  private background(work: () => Promise<unknown>) {
    void this.keepAliveWhile(work)
      .catch((error: unknown) => console.error("Background run failed:", error))
      .finally(() => this.publish());
  }
}
