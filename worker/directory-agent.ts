import { Agent, type Connection, type ConnectionContext, callable, getAgentByName, getCurrentAgent } from "agents";
import { DIRECTORY_NAME, isStudioId } from "../src/app/courses.js";
import { DirectoryService } from "../src/app/directory.js";
import { type Identity, identityFrom } from "../src/auth/identity.js";
import type { Sql } from "../src/storage/sql.js";

interface ConnectionState {
  identity: Identity;
}

/**
 * The course directory, one Durable Object named "main": which courses exist and who belongs to which.
 * A thin wrapper around DirectoryService (src/app/directory.ts). Browsers call the @callable methods as
 * the signed-in person; the other public methods are Durable Object RPC, reachable only through the
 * Worker's bindings (the Worker and course objects), never from a browser.
 */
export class DirectoryAgent extends Agent<Env, Record<string, never>> {
  initialState = {};
  private service?: DirectoryService;

  private get app(): DirectoryService {
    this.service ??= new DirectoryService(this.sql.bind(this) as unknown as Sql);
    return this.service;
  }

  override onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    if (this.name !== DIRECTORY_NAME) {
      connection.close(4004, "No such directory");
      return;
    }
    const identity = identityFrom(ctx.request);
    if (!identity) {
      connection.close(4001, "Unauthorized");
      return;
    }
    connection.setState({ identity });
  }

  override validateStateChange(_next: Record<string, never>, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only");
  }

  /** The signed-in person on the calling connection. Anyone signed in may list and create courses. */
  private actor(): Identity {
    const identity = (getCurrentAgent().connection as Connection<ConnectionState> | undefined)?.state?.identity;
    if (!identity) throw new Error("Sign in to continue");
    return identity;
  }

  /** Courses I own, courses shared with me, and the featured ones. */
  @callable()
  myCourses() {
    return this.app.myCourses(this.actor().userId);
  }

  /** Creates a draft course owned by the caller and sets up its course object. Returns its id. */
  @callable()
  async createCourse(input: unknown) {
    const owner = this.actor();
    const record = this.app.createCourse(owner.userId, input);
    try {
      const course = await getAgentByName(this.env.CourseAgent, record.id);
      await course.initialise({ id: record.id, title: record.title, description: record.description, owner });
    } catch (error) {
      console.error(`Couldn't initialise course ${record.id}:`, error);
      this.app.remove(record.id);
      throw new Error("Couldn't create the course; try again");
    }
    console.log(`Course ${record.id} created by ${owner.userId}`);
    return { id: record.id };
  }

  // ─── RPC only (not @callable): the Worker and course objects ─────────

  /** Whether a studio course with this id exists: the Worker asks before routing to a course object. */
  courseExists(id: unknown): boolean {
    return typeof id === "string" && isStudioId(id) && this.app.exists(id);
  }

  /** A course object reports a new title, description or status. */
  courseUpdated(id: string, patch: unknown) {
    this.app.courseUpdated(id, patch);
  }

  /** A course object reports a membership change (role null: removed). */
  membershipChanged(id: string, userId: unknown, role: unknown) {
    this.app.membershipChanged(id, userId, role);
  }
}
