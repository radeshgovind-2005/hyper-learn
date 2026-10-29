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
  | "manage_roles";

const GRANTS: Record<Role, readonly Permission[]> = {
  learner: ["learn"],
  instructor: ["learn", "repair", "view_learners"],
  admin: ["learn", "repair", "view_learners", "reset", "manage_roles"],
};

/** Someone's role in one studio course, stored in that course's object. */
export const COURSE_ROLES = ["owner", "editor", "learner"] as const;
export type CourseRole = (typeof COURSE_ROLES)[number];

export const can = (role: Role, permission: Permission) => GRANTS[role].includes(permission);

/** Every permission a role has, for the UI to show or hide controls. */
export const permissionsOf = (role: Role): Permission[] => [...GRANTS[role]];

export class AccessDenied extends Error {}

/** The identity, if it may do this; otherwise throws a message fit to show the person. */
export function requirePermission(identity: Identity | null | undefined, permission: Permission): Identity {
  if (!identity) throw new AccessDenied("Sign in to continue");
  if (!can(identity.role, permission)) throw new AccessDenied(`Your role (${identity.role}) can't do that`);
  return identity;
}
