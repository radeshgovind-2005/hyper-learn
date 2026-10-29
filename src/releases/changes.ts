import { z } from "zod";
import type { CourseSnapshot, LessonNode } from "../course/compile.js";

// Changes to the course, as typed operations on a snapshot. Every change is applied to a copy,
// has an exact inverse (so a release can be reverted), and has a risk tier and semver bump that
// code assigns. The agent that proposed it never decides either.

export const ChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add_prerequisite"),
    lesson: z.string(),
    prerequisite: z.string(),
    /** Where to insert it in the lesson's list (default: the end). Lets a revert restore the exact order. */
    at: z.number().int().min(0).optional(),
  }),
  z.strictObject({ op: z.literal("remove_prerequisite"), lesson: z.string(), prerequisite: z.string() }),
  /** Hide a lesson, section or block from learners. Nothing is deleted; restore_node brings it back. */
  z.strictObject({ op: z.literal("archive_node"), node_id: z.string() }),
  z.strictObject({ op: z.literal("restore_node"), node_id: z.string() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/**
 * R0 = additive content, R1 = changes what or in which order learners study, R2 = drastic (whole
 * lessons, the quiz). Autopilot may never approve R2 on its own.
 */
export type RiskTier = "R0" | "R1" | "R2";
export type Bump = "major" | "minor" | "patch";

type NodeRef =
  | { kind: "lesson"; lesson: LessonNode }
  | { kind: "section"; lesson: LessonNode; index: number }
  | { kind: "block"; lesson: LessonNode; section: number; index: number };

/** Finds a lesson, section or block by id in a snapshot. */
export function findNode(snapshot: CourseSnapshot, id: string): NodeRef | undefined {
  for (const lesson of snapshot.lessons) {
    if (lesson.id === id) return { kind: "lesson", lesson };
    for (const [s, section] of lesson.sections.entries()) {
      if (section.id === id) return { kind: "section", lesson, index: s };
      const b = section.blocks.findIndex((block) => block.id === id);
      if (b >= 0) return { kind: "block", lesson, section: s, index: b };
    }
  }
  return undefined;
}

function nodeArchived(ref: NodeRef): boolean {
  if (ref.kind === "lesson") return ref.lesson.archived;
  if (ref.kind === "section") return ref.lesson.sections[ref.index]!.archived;
  return ref.lesson.sections[ref.section]!.blocks[ref.index]!.archived;
}

function setArchived(ref: NodeRef, archived: boolean) {
  if (ref.kind === "lesson") ref.lesson.archived = archived;
  else if (ref.kind === "section") ref.lesson.sections[ref.index]!.archived = archived;
  else ref.lesson.sections[ref.section]!.blocks[ref.index]!.archived = archived;
}

class ChangeError extends Error {}

const lessonOf = (snapshot: CourseSnapshot, id: string) => {
  const lesson = snapshot.lessons.find((l) => l.id === id);
  if (!lesson) throw new ChangeError(`no lesson "${id}"`);
  return lesson;
};
const nodeOf = (snapshot: CourseSnapshot, id: string) => {
  const ref = findNode(snapshot, id);
  if (!ref) throw new ChangeError(`no lesson, section or block "${id}"`);
  return ref;
};

/**
 * Applies one change to a copy of the snapshot. Throws a ChangeError if the change doesn't fit the
 * snapshot (unknown ids, an edge that already exists…). Course-wide invariants are checked separately,
 * on the whole candidate (see planRelease).
 */
export function applyChange(snapshot: CourseSnapshot, change: Change): CourseSnapshot {
  const next = structuredClone(snapshot);
  switch (change.op) {
    case "add_prerequisite": {
      const lesson = lessonOf(next, change.lesson);
      lessonOf(next, change.prerequisite);
      if (lesson.prerequisites.includes(change.prerequisite)) {
        throw new ChangeError(`"${change.prerequisite}" is already a prerequisite of "${change.lesson}"`);
      }
      lesson.prerequisites.splice(change.at ?? lesson.prerequisites.length, 0, change.prerequisite);
      break;
    }
    case "remove_prerequisite": {
      const lesson = lessonOf(next, change.lesson);
      if (!lesson.prerequisites.includes(change.prerequisite)) {
        throw new ChangeError(`"${change.prerequisite}" is not a prerequisite of "${change.lesson}"`);
      }
      lesson.prerequisites = lesson.prerequisites.filter((p) => p !== change.prerequisite);
      break;
    }
    case "archive_node":
    case "restore_node": {
      const ref = nodeOf(next, change.node_id);
      const archive = change.op === "archive_node";
      if (nodeArchived(ref) === archive) throw new ChangeError(`"${change.node_id}" is already ${archive ? "archived" : "live"}`);
      setArchived(ref, archive);
      break;
    }
  }
  return next;
}

/** The change that undoes `change`, given the snapshot it was applied to. */
export function invertChange(before: CourseSnapshot, change: Change): Change {
  switch (change.op) {
    case "add_prerequisite":
      return { op: "remove_prerequisite", lesson: change.lesson, prerequisite: change.prerequisite };
    case "remove_prerequisite": {
      const at = lessonOf(before, change.lesson).prerequisites.indexOf(change.prerequisite);
      return { op: "add_prerequisite", lesson: change.lesson, prerequisite: change.prerequisite, at };
    }
    case "archive_node":
      return { op: "restore_node", node_id: change.node_id };
    case "restore_node":
      return { op: "archive_node", node_id: change.node_id };
  }
}

/** Applies changes in order; throws on the first that doesn't fit. */
export const applyChanges = (snapshot: CourseSnapshot, changes: readonly Change[]) =>
  changes.reduce(applyChange, snapshot);

/** The inverse changeset, in reverse order, that turns `apply(before, changes)` back into `before`. */
export function invertChanges(before: CourseSnapshot, changes: readonly Change[]): Change[] {
  const inverses: Change[] = [];
  let current = before;
  for (const change of changes) {
    inverses.unshift(invertChange(current, change));
    current = applyChange(current, change);
  }
  return inverses;
}

export function riskTier(snapshot: CourseSnapshot, change: Change): RiskTier {
  switch (change.op) {
    case "add_prerequisite":
    case "remove_prerequisite":
      return "R1";
    case "archive_node":
    case "restore_node":
      return findNode(snapshot, change.node_id)?.kind === "lesson" ? "R2" : "R1";
  }
}

export function semverBump(snapshot: CourseSnapshot, change: Change): Bump {
  switch (change.op) {
    case "add_prerequisite":
    case "remove_prerequisite":
      return "major"; // changes the path every learner must follow
    case "archive_node":
    case "restore_node":
      return findNode(snapshot, change.node_id)?.kind === "lesson" ? "major" : "minor";
  }
}

const TIER_ORDER: RiskTier[] = ["R0", "R1", "R2"];
const BUMP_ORDER: Bump[] = ["patch", "minor", "major"];
export const maxTier = (tiers: RiskTier[]) => TIER_ORDER[Math.max(0, ...tiers.map((t) => TIER_ORDER.indexOf(t)))]!;
export const maxBump = (bumps: Bump[]) => BUMP_ORDER[Math.max(0, ...bumps.map((b) => BUMP_ORDER.indexOf(b)))]!;

/** One line per change, for logs, approval cards and the release history. */
export function describeChange(change: Change): string {
  switch (change.op) {
    case "add_prerequisite":
      return `${change.lesson} now requires ${change.prerequisite}`;
    case "remove_prerequisite":
      return `${change.lesson} no longer requires ${change.prerequisite}`;
    case "archive_node":
      return `archive ${change.node_id}`;
    case "restore_node":
      return `restore ${change.node_id}`;
  }
}

export { ChangeError };
