import type { Identity, Role } from "../auth/identity.js";

// Who may do what. One table, checked in code on every call; the UI only hides what this forbids.

export type Permission =
  /** Read lessons, take quizzes, see and delete one's own progress, record one's own activity. */
  | "learn"
  /** Run course repair, approve trials, evaluate or stop trials. */
  | "repair"
  /** See every learner's progress and sessions. */
  | "view_learners"
  /** Reset the course to v1.0.0. */
  | "reset"
  /** Change other people's roles. */
  | "manage_roles"
  /** A studio course's owner: sources, model key, build, publish, invites and members. */
  | "manage_course";

const GRANTS: Record<Role, readonly Permission[]> = {
  learner: ["learn"],
  instructor: ["learn", "repair", "view_learners"],
  admin: ["learn", "repair", "view_learners", "reset", "manage_roles"],
};

export const can = (role: Role, permission: Permission) => GRANTS[role].includes(permission);

/** Every permission a role has, for the UI to show or hide controls. */
export const permissionsOf = (role: Role): Permission[] => [...GRANTS[role]];

// Studio courses: what someone may do comes from their role in that course, stored in the course's
// object. Global admins may do everything anywhere. The featured course keeps the global roles above.

/** Someone's role in one studio course. */
export const COURSE_ROLES = ["owner", "editor", "learner"] as const;
export type CourseRole = (typeof COURSE_ROLES)[number];

const COURSE_GRANTS: Record<CourseRole, readonly Permission[]> = {
  owner: ["learn", "repair", "view_learners", "reset", "manage_course"],
  // Editors help run a course (repair, trials, learners); its material, key, members and publishing stay with the owner.
  editor: ["learn", "repair", "view_learners"],
  learner: ["learn"],
};

const EVERYTHING: readonly Permission[] = ["learn", "repair", "view_learners", "reset", "manage_roles", "manage_course"];

export interface CourseAccess {
  /** The featured course: global roles apply, course roles don't exist. */
  featured: boolean;
  /** The role from the person's session token. */
  global: Role;
  /** Their role in this course, or null if they aren't a member. */
  course: CourseRole | null;
}

/** Every permission someone has in one course. Pure: the course object looks up the roles, this decides. */
export function coursePermissions({ featured, global, course }: CourseAccess): Permission[] {
  if (featured) return permissionsOf(global);
  if (global === "admin") return [...EVERYTHING];
  return course ? [...COURSE_GRANTS[course]] : [];
}

/** Whether someone may open a course at all (connect to it). */
export const mayEnter = (access: CourseAccess) => coursePermissions(access).length > 0;

export class AccessDenied extends Error {}

/** The identity, if it may do this; otherwise throws a message fit to show the person. */
export function requirePermission(identity: Identity | null | undefined, permission: Permission): Identity {
  if (!identity) throw new AccessDenied("Sign in to continue");
  if (!can(identity.role, permission)) throw new AccessDenied(`Your role (${identity.role}) can't do that`);
  return identity;
}

/** As requirePermission, in one course: `courseRole` is the caller's role there (null: not a member). */
export function requireCoursePermission(
  identity: Identity | null | undefined,
  { featured, courseRole }: { featured: boolean; courseRole: CourseRole | null },
  permission: Permission,
): Identity {
  if (!identity) throw new AccessDenied("Sign in to continue");
  if (featured) return requirePermission(identity, permission);
  if (!coursePermissions({ featured, global: identity.role, course: courseRole }).includes(permission)) {
    throw new AccessDenied(courseRole ? `Your role in this course (${courseRole}) can't do that` : "You aren't a member of this course");
  }
  return identity;
}
