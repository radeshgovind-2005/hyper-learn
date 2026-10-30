import { z } from "zod";
import type { Sql } from "../storage/sql.js";
import { COURSE_ROLES, type CourseRole } from "./access.js";
import { BUILT_IN_COURSES, builtInCourse, newCourseId } from "./courses.js";

// The list of courses and who belongs to which, for the sidebar ("mine", "shared with me", "featured")
// and for the Worker's check that a course id exists. One directory object holds it. Each course object
// stays the authority on its own members; it reports changes here so lists don't have to ask every course.

export const COURSE_STATUSES = ["draft", "building", "review", "published"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

/** Most studio courses one person may own: each one is a Durable Object. */
export const MAX_COURSES_PER_OWNER = 20;

export interface CourseRecord {
  id: string;
  title: string;
  description: string;
  owner: string;
  status: CourseStatus;
  created_at: string;
}

/** A course as a list shows it, with the viewer's role (null on a featured course they haven't joined). */
export interface CourseCard extends Omit<CourseRecord, "owner"> {
  role: CourseRole | null;
  featured: boolean;
}

export const CourseDetailsSchema = z.strictObject({
  title: z.string().trim().min(1, "Give the course a title").max(120),
  description: z.string().trim().max(2_000).default(""),
});
export type CourseDetails = z.infer<typeof CourseDetailsSchema>;

/** The first readable problem in a Zod error. */
export const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid input";

const UpdateSchema = z.strictObject({
  title: CourseDetailsSchema.shape.title.optional(),
  description: CourseDetailsSchema.shape.description.optional(),
  status: z.enum(COURSE_STATUSES).optional(),
});

const USER_ID = z.string().min(1).max(200);

function createDirectoryTables(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS dir_courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS dir_members (
    course_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (course_id, user_id)
  )`;
  sql`CREATE INDEX IF NOT EXISTS dir_members_user ON dir_members (user_id)`;
}

export class DirectoryService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly sql: Sql,
    options: { now?: () => string; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? newCourseId;
    createDirectoryTables(sql);
  }

  /** Records a new course owned by `owner`. The caller then initialises its course object (and calls remove if that fails). */
  createCourse(owner: string, input: unknown): CourseRecord {
    const parsed = CourseDetailsSchema.safeParse(input);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const [{ n }] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM dir_courses WHERE owner = ${owner}` as [{ n: number }];
    if (n >= MAX_COURSES_PER_OWNER) throw new Error(`You already own ${MAX_COURSES_PER_OWNER} courses; delete one first`);
    let id = this.newId();
    while (this.exists(id)) id = this.newId();
    const record: CourseRecord = { id, ...parsed.data, owner, status: "draft", created_at: this.now() };
    this.sql`INSERT INTO dir_courses (id, title, description, owner, status, created_at)
      VALUES (${record.id}, ${record.title}, ${record.description}, ${owner}, ${record.status}, ${record.created_at})`;
    this.sql`INSERT INTO dir_members (course_id, user_id, role) VALUES (${id}, ${owner}, 'owner')`;
    return record;
  }

  /** Forgets a course and its memberships (a course object that couldn't be initialised). */
  remove(id: string) {
    this.sql`DELETE FROM dir_members WHERE course_id = ${id}`;
    this.sql`DELETE FROM dir_courses WHERE id = ${id}`;
  }

  exists(id: string): boolean {
    return this.sql`SELECT id FROM dir_courses WHERE id = ${id}`.length > 0;
  }

  get(id: string): CourseRecord | undefined {
    return this.sql<CourseRecord>`SELECT * FROM dir_courses WHERE id = ${id}`[0];
  }

  /** A course object reports a new title, description or status. Unknown ids and fields are refused. */
  courseUpdated(id: string, patch: unknown) {
    const parsed = UpdateSchema.safeParse(patch);
    if (!parsed.success) throw new Error(firstIssue(parsed.error));
    const current = this.get(id);
    if (!current) throw new Error(`No course ${id}`);
    const next = { ...current, ...parsed.data };
    this.sql`UPDATE dir_courses SET title = ${next.title}, description = ${next.description}, status = ${next.status} WHERE id = ${id}`;
  }

  /** A course object reports that someone's role changed (null: they left or were removed). */
  membershipChanged(courseId: string, userId: unknown, role: unknown) {
    if (!this.exists(courseId)) throw new Error(`No course ${courseId}`);
    const user = USER_ID.parse(userId);
    if (role === null) {
      this.sql`DELETE FROM dir_members WHERE course_id = ${courseId} AND user_id = ${user}`;
      return;
    }
    const parsed = z.enum(COURSE_ROLES).parse(role);
    this.sql`INSERT INTO dir_members (course_id, user_id, role) VALUES (${courseId}, ${user}, ${parsed})
      ON CONFLICT (course_id, user_id) DO UPDATE SET role = excluded.role`;
  }

  /** The sidebar: courses I own, courses shared with me, and the featured ones. */
  myCourses(userId: string): { owned: CourseCard[]; shared: CourseCard[]; featured: CourseCard[] } {
    const rows = this.sql<CourseRecord & { role: CourseRole }>`
      SELECT c.*, m.role AS role FROM dir_members m JOIN dir_courses c ON c.id = m.course_id
      WHERE m.user_id = ${userId} ORDER BY c.created_at DESC`;
    const card = ({ owner: _owner, ...row }: CourseRecord & { role: CourseRole }): CourseCard => ({ ...row, featured: false });
    return {
      owned: rows.filter((r) => r.role === "owner").map(card),
      shared: rows.filter((r) => r.role !== "owner").map(card),
      featured: BUILT_IN_COURSES.map((id) => {
        const base = builtInCourse(id)!.base;
        return { id, title: base.title, description: "", status: "published", role: null, featured: true, created_at: "" };
      }),
    };
  }
}
