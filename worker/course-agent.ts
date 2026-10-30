import { Agent, type Connection, type ConnectionContext, callable, getAgentByName, getCurrentAgent } from "agents";
import { coursePermissions, mayEnter, type Permission, requireCoursePermission } from "../src/app/access.js";
import { builtInCourse, DIRECTORY_NAME, isBuiltIn, isStudioId } from "../src/app/courses.js";
import type { CourseDetailsInput } from "../src/app/directory.js";
import { CourseService, type DataSource, type DirectoryLink, parseApproval, type QuizResult } from "../src/app/service.js";
import type { Certainty, Response } from "../src/assessment/items.js";
import { type Identity, identityFrom } from "../src/auth/identity.js";
import { checkRoleChange, setClerkRole } from "../src/auth/roles.js";
import { ModelProvider, modelChoicesFromEnv, modelConfigFromEnv } from "../src/models.js";
import { LANGSMITH_SETTINGS } from "../src/observability.js";
import type { ApprovalMode } from "../src/nodes/release.js";
import type { Sql } from "../src/storage/sql.js";
import { workersAiEmbedder, workersAiGuard } from "./ai.js";
import { coachRepairer, courseBuilder, courseEditor } from "./builder.js";

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
      // The Worker's own model key is for built-in courses only; a studio course uses its owner's.
      const builtIn = course !== "studio";
      this.service = new CourseService(this.sql.bind(this) as unknown as Sql, {
        course,
        directory: this.directoryLink(),
        ...(builtIn
          ? { agentsAvailable: Boolean(env.MODEL_API_KEY && env.MODEL_BASE_URL), models: new ModelProvider(modelConfigFromEnv(env)) }
          : {
              ...(courseBuilder && { builder: courseBuilder }),
              editor: courseEditor,
              repairer: coachRepairer,
              ownerModels: {
                secret: env.KEY_ENCRYPTION_SECRET,
                // The Worker's endpoint and limits; the key comes from the owner, opened only when used.
                config: { ...modelConfigFromEnv(env), apiKey: "" },
                choices: modelChoicesFromEnv(env),
              },
            }),
        ...(env.AI && { guard: workersAiGuard(env.AI), embedder: workersAiEmbedder(env.AI) }),
      });
    }
    return this.service;
  }

  /** How often an open trial on real learners is re-measured, in seconds. */
  static readonly TRIAL_CHECK_INTERVAL = 3600;

  override async onStart() {
    if (!this.known()) return;
    this.pushState();
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
  async initialise(input: { id: string; owner: Identity } & CourseDetailsInput) {
    if (input?.id !== this.name) throw new Error("Course id doesn't match this object");
    const record = this.app.initialise(input);
    this.pushState();
    await this.scheduleEvery(CourseAgent.TRIAL_CHECK_INTERVAL, "checkTrial");
    return { id: record.id };
  }

  /** Set once wipe() starts: nothing more is recorded in storage that is about to go. */
  private deleted = false;

  /**
   * Deletes this course for good, for the directory's deleteCourse() (which checked the caller may).
   * Everyone connected is told and disconnected first. Then destroy(), the Agents SDK's documented
   * teardown: it cancels schedules (the hourly trial check) and the alarm, deletes all storage
   * (ctx.storage.deleteAll) and resets the object. Calling ctx.storage.deleteAll ourselves would leave the
   * SDK's alarm and schedules behind. destroy() aborts the isolate just after it returns, so the directory
   * may see this call fail although it worked; wiping again is harmless, and the course stays listed until it succeeds.
   */
  async wipe() {
    if (!isStudioId(this.name)) throw new Error("Built-in courses can't be deleted");
    this.deleted = true;
    for (const connection of this.getConnections()) connection.close(4004, "This course was deleted");
    await this.destroy();
  }

  /** Joins with an invite token, for the directory's join(). Returns the caller's role in the course. */
  redeemInvite(person: Identity, token: unknown) {
    if (!this.known() || isBuiltIn(this.name)) throw new Error("This invite link is no longer valid");
    if (typeof person?.userId !== "string" || !person.userId) throw new Error("Sign in to continue");
    return this.app.join(person, token);
  }

  /** Scheduled, not callable by clients: decides an open real trial once both arms have enough learners. */
  async checkTrial() {
    const result = this.app.evaluateTrial(() => this.pushState());
    if (result.status !== "none") this.pushState();
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
    // A studio course is for its members (and admins): others never see its state.
    if (!mayEnter(this.access(identity))) {
      connection.close(4003, "Not a member of this course");
      return;
    }
    connection.setState({ identity, connectedAt: new Date().toISOString() });
    this.app.recordProfile(identity);
    this.app.startSession(identity.userId, connection.id);
  }

  override onClose(connection: Connection<ConnectionState>) {
    const identity = connection.state?.identity;
    if (identity && !this.deleted) this.app.endSession(identity.userId, connection.id);
  }

  /** State is the server's view; a browser can't overwrite what other people see. */
  override validateStateChange(_next: CourseAgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only");
  }

  private pushState() {
    this.setState({ overview: this.app.overview() });
  }

  /** Someone's standing in this course: global roles on the featured course, course roles elsewhere. */
  private access(identity: Identity) {
    return { featured: isBuiltIn(this.name), global: identity.role, course: this.app.memberRole(identity.userId) };
  }

  /**
   * The person calling, if their role allows `permission`; otherwise the call fails with a readable message.
   * Course roles are read on every call, so a change applies at once.
   */
  private actor(permission: Permission): Identity {
    const identity = (getCurrentAgent().connection as Connection<ConnectionState> | undefined)?.state?.identity;
    const courseRole = identity ? this.app.memberRole(identity.userId) : null;
    return requireCoursePermission(identity, { featured: isBuiltIn(this.name), courseRole }, permission);
  }

  /** Who I am and what I may do, for the UI to show or hide controls. */
  @callable()
  me() {
    const identity = this.actor("learn");
    // Role changes need Clerk's secret key; without it, admins see roles but can't change them here.
    const rolesConfigured = Boolean((this.env as unknown as { CLERK_SECRET_KEY?: string }).CLERK_SECRET_KEY);
    const access = this.access(identity);
    return { ...identity, courseRole: access.course, permissions: coursePermissions(access), rolesConfigured };
  }

  // ─── Members and invites (studio courses; owner, or an admin) ────────

  @callable()
  members() {
    this.actor("manage_course");
    return this.app.memberList();
  }

  /** Makes a member an editor or a learner. */
  @callable()
  async setMemberRole(userId: string, role: string) {
    const { userId: by } = this.actor("manage_course");
    const member = await this.app.setMemberRole(String(userId), role);
    console.log(`Course ${this.name}: ${member.user_id} is now ${member.role} (by ${by})`);
    return member;
  }

  /** Removes a member; their open connections are closed. */
  @callable()
  async removeMember(userId: string) {
    this.actor("manage_course");
    await this.app.removeMember(String(userId));
    this.disconnect(String(userId), "Removed from this course");
  }

  /** Leaves this course. */
  @callable()
  async leave() {
    const { userId } = this.actor("learn");
    await this.app.leave(userId);
    this.disconnect(userId, "Left this course");
  }

  /** The current invite link's token (null when there is none). */
  @callable()
  invite() {
    this.actor("manage_course");
    return this.app.invite();
  }

  /** A new invite token; the previous link stops working. */
  @callable()
  rotateInvite() {
    this.actor("manage_course");
    return this.app.rotateInvite();
  }

  @callable()
  revokeInvite() {
    this.actor("manage_course");
    this.app.revokeInvite();
  }

  // ─── Course details, sources and model key (owner, or an admin) ───────

  /** Title, description, goal (guides the build), language, audience and status, for the owner's form. */
  @callable()
  details() {
    this.actor("manage_course");
    return this.app.details();
  }

  /** Title, description, goal (guides the build), language and audience. */
  @callable()
  async updateDetails(input: unknown) {
    this.actor("manage_course");
    const info = await this.app.updateDetails(input);
    this.pushState();
    return info;
  }

  /** The uploaded files, without their text. */
  @callable()
  sources() {
    this.actor("manage_course");
    return this.app.sourceList();
  }

  /** Adds a file as page texts ({ name, pages, role? }); a big file continues with appendPages. */
  @callable()
  addSource(input: unknown) {
    this.actor("manage_course");
    return this.app.addSource(input);
  }

  @callable()
  appendPages(id: string, pages: unknown) {
    this.actor("manage_course");
    return this.app.appendPages(id, pages);
  }

  @callable()
  removeSource(id: string) {
    this.actor("manage_course");
    this.app.removeSource(id);
  }

  /** material | assessment | brief, or null to let the build decide. */
  @callable()
  setSourceRole(id: string, role: string | null) {
    this.actor("manage_course");
    return this.app.setSourceRole(id, role);
  }

  /** Any page (1-based) of any of the course's files, for the owner's viewer. */
  @callable()
  ownerSourcePage(id: string, page: number) {
    this.actor("manage_course");
    return this.app.ownerSourcePage(id, page);
  }

  /** Whether learners may open a file from the lessons that cite it (past exams and briefs never). */
  @callable()
  setSourceShared(id: string, shared: boolean) {
    this.actor("manage_course");
    // Not in the shared state: learners' pages ask for citedSources when they open the course.
    return this.app.setSourceShared(id, shared);
  }

  /** Whether a key is set and which model is used. The key itself is never returned. */
  @callable()
  modelSettings() {
    this.actor("manage_course");
    return this.app.modelSettings();
  }

  /** Stores the owner's model API key, encrypted, and the model (one of MODEL_CHOICES). */
  @callable()
  async setModelKey(key: string, model: string) {
    const { userId } = this.actor("manage_course");
    const settings = await this.app.setModelKey(key, model);
    console.log(`Course ${this.name}: model key set by ${userId} (model ${settings.model})`);
    this.pushState();
    return settings;
  }

  @callable()
  clearModelKey() {
    this.actor("manage_course");
    const settings = this.app.clearModelKey();
    this.pushState();
    return settings;
  }

  // ─── Lifecycle (owner, or an admin) ──────────────────────────────────

  /**
   * Builds the course from its sources with the owner's key. Checks happen before returning; the build
   * continues in the background and its steps reach the UI through state (overview.build).
   */
  @callable()
  build() {
    this.actor("manage_course");
    const build = this.app.beginBuild(() => this.pushState());
    this.background(() => this.app.continueBuild(build, () => this.pushState()));
  }

  // ─── Study coach (any learner): diagnose → personal repair → re-check ──
  // Personal state never goes into the shared overview; the page asks for it (and polls while a lesson is written).

  @callable()
  coachState() {
    const { userId } = this.actor("learn");
    return this.app.coachState(userId);
  }

  @callable()
  startDiagnosis(lesson: string, note?: string) {
    const { userId } = this.actor("learn");
    return this.app.startDiagnosis(userId, lesson, note);
  }

  @callable()
  submitDiagnosis(id: string, answers: unknown) {
    const { userId } = this.actor("learn");
    return this.app.submitDiagnosis(userId, id, answers);
  }

  /** Repairs a target from the diagnosis (default: its priority); `again` tries the next approach. */
  @callable()
  startRepair(target?: string, again?: boolean) {
    const { userId } = this.actor("learn");
    const { state, write } = this.app.beginRepair(userId, target, again === true);
    if (write) this.background(() => this.app.continueRepair(userId));
    return state;
  }

  @callable()
  submitRecheck(id: string, answers: unknown) {
    const { userId } = this.actor("learn");
    return this.app.submitRecheck(userId, id, answers);
  }

  /** What learners keep needing repaired (owners, editors, instructors). */
  @callable()
  coachInsights() {
    this.actor("view_learners");
    return this.app.coachInsights();
  }

  // ─── Owner edits: tune a section, ask for a change, add a file ──────

  /**
   * Starts preparing an edit ({ kind: "tune" | "ask" | "add_source", … }). Before publishing it's the
   * owner's; after, editors may ask too (it's how they repair the course in their own words). The
   * proposal reaches the UI through state (overview.edit).
   */
  @callable()
  requestEdit(request: unknown) {
    const { userId } = this.actor(this.app.record()?.status === "published" ? "repair" : "manage_course");
    const edit = this.app.beginEdit(request, userId, () => this.pushState());
    this.background(() => this.app.continueEdit(edit, () => this.pushState()));
    return { id: edit.id };
  }

  /** Applies the ready proposal: to the draft, or as a new live release. */
  @callable()
  applyEdit(id: string) {
    const { userId } = this.actor(this.app.record()?.status === "published" ? "repair" : "manage_course");
    const result = this.app.applyEdit(id, userId);
    console.log(`Course ${this.name}: edit ${id} applied as ${result.applied_as} by ${userId}`);
    this.pushState();
    return result;
  }

  /** Undoes the live release as a new version (its recorded inverse). */
  @callable()
  undoRelease(version: string) {
    const { userId } = this.actor("repair");
    const result = this.app.undoRelease(version, userId);
    console.log(`Course ${this.name}: v${version} undone as v${result.live} by ${userId}`);
    this.pushState();
    return result;
  }

  @callable()
  discardEdit() {
    this.actor(this.app.record()?.status === "published" ? "repair" : "manage_course");
    this.app.discardEdit();
    this.pushState();
  }

  /** The built course, to review before publishing. */
  @callable()
  draft() {
    this.actor("manage_course");
    return this.app.draft();
  }

  /** Makes the built course release 1.0.0, live for learners. */
  @callable()
  publish() {
    const { userId } = this.actor("manage_course");
    const result = this.app.publish();
    console.log(`Course ${this.name} published by ${userId}`);
    this.pushState();
    return result;
  }

  private disconnect(userId: string, reason: string) {
    for (const connection of this.getConnections<ConnectionState>()) {
      if (connection.state?.identity.userId === userId) connection.close(4003, reason);
    }
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

  /** The questions the caller's next attempt at a lesson shows (drawn per attempt for lessons with an exam). */
  @callable()
  exam(lesson: string) {
    const { userId } = this.actor("learn");
    return this.app.exam(userId, String(lesson));
  }

  /** `item_ids`: the questions exam() returned, in the order answered. */
  @callable()
  submitQuiz(lesson: string, answers: Response[], certainty: Certainty[], item_ids?: string[]): QuizResult {
    const { userId } = this.actor("learn");
    return this.app.submitQuiz(userId, String(lesson), answers, certainty, this.connectionId(), item_ids);
  }

  /** An answer to a practice check after a section: its feedback, recorded as evidence. */
  @callable()
  answerCheck(blockId: string, option: number) {
    const { userId } = this.actor("learn");
    return this.app.answerCheck(userId, String(blockId), option, this.connectionId());
  }

  /** The files the caller may open from the lessons that cite them, on the release they are served. */
  @callable()
  citedSources() {
    const { userId } = this.actor("learn");
    return this.app.citedSources(userId);
  }

  /** A page (1-based) of a file citedSources lists. */
  @callable()
  sourcePage(id: string, page: number) {
    const { userId } = this.actor("learn");
    return this.app.sourcePage(userId, id, page);
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
    this.pushState();
  }

  /**
   * Starts a repair run. Checks happen before returning, so the caller hears "already running";
   * the run itself continues in the background and reaches the UI through state updates.
   */
  @callable()
  startRun(mode: ApprovalMode, agents: boolean, source: DataSource = "simulated") {
    this.actor("repair");
    const run = this.app.beginRun({ mode, agents, source }, () => this.pushState());
    this.background(() => this.app.continueRun(run, () => this.pushState()));
  }

  /** Answers the pending approval. A second answer to the same approval is refused here, not lost. */
  @callable()
  approve(response: unknown) {
    const { userId } = this.actor("repair");
    const answer = parseApproval(response);
    const run = this.app.beginApproval(() => this.pushState());
    this.background(() => this.app.continueApproval(run, { ...answer, note: answer.note ?? `${answer.approved ? "approved" : "rejected"} by ${userId}` }, () => this.pushState()));
  }

  /** Measures the open real trial now instead of waiting for the hourly check. */
  @callable()
  evaluateTrial() {
    this.actor("repair");
    const result = this.app.evaluateTrial(() => this.pushState());
    this.pushState();
    return result;
  }

  /** Ends the open real trial without a measurement: reverted, everyone back on the live release. */
  @callable()
  stopTrial() {
    const { userId } = this.actor("repair");
    this.app.stopTrial(userId, () => this.pushState());
    this.pushState();
  }

  private background(work: () => Promise<unknown>) {
    void this.keepAliveWhile(work)
      .catch((error: unknown) => console.error("Background run failed:", error))
      .finally(() => this.pushState());
  }
}
