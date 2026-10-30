import { z } from "zod";
import type { QuizItem } from "../assessment/items.js";
import type { Block, CheckBlock, CourseSnapshot, LessonNode, Section, TextBlock } from "../course/compile.js";
import type { MisconceptionDef, Objective } from "../course/schema.js";
import { type Intervention, InterventionSchema } from "../interventions/templates.js";

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
  /** Add an intervention block to a section. Code assigns the block id (`<section>/i<n>`) unless reverting. */
  z.strictObject({
    op: z.literal("add_block"),
    section_id: z.string(),
    intervention: InterventionSchema,
    block_id: z.string().optional(),
    at: z.number().int().min(0).optional(),
  }),
  /** Only ever the inverse of add_block or insert_block, so a reverted release matches its parent exactly. Agents archive instead. */
  z.strictObject({ op: z.literal("remove_block"), block_id: z.string() }),
  // Owner edits (src/edit). Their content is built and checked in code, never taken from an agent as is,
  // and the whole candidate is validated after applying, so the payloads are only shape-checked here.
  /** Add a text or check block to a section; the block carries its own id. */
  z.strictObject({ op: z.literal("insert_block"), section_id: z.string(), block: z.custom<TextBlock | CheckBlock>(isObject), at: z.number().int().min(0).optional() }),
  /** Add a section to a lesson; `objectives` are existing objectives it now also teaches. */
  z.strictObject({
    op: z.literal("add_section"),
    lesson_id: z.string(),
    section: z.custom<Section>(isObject),
    at: z.number().int().min(0).optional(),
    objectives: z.array(z.string()).optional(),
  }),
  /** Only ever the inverse of add_section. */
  z.strictObject({ op: z.literal("remove_section"), section_id: z.string() }),
  /** Add a whole lesson with its objectives and misconceptions. */
  z.strictObject({
    op: z.literal("add_lesson"),
    lesson: z.custom<LessonNode>(isObject),
    objectives: z.custom<Objective[]>(Array.isArray),
    misconceptions: z.custom<MisconceptionDef[]>(Array.isArray),
    at: z.number().int().min(0).optional(),
  }),
  /** Only ever the inverse of add_lesson. */
  z.strictObject({ op: z.literal("remove_lesson"), lesson_id: z.string() }),
  /** Add questions to a lesson's exam pool, optionally with the new objective they test. */
  z.strictObject({ op: z.literal("add_items"), lesson_id: z.string(), items: z.custom<QuizItem[]>(Array.isArray), objective: z.custom<Objective>(isObject).optional() }),
  /** Only ever the inverse of add_items. */
  z.strictObject({ op: z.literal("remove_items"), lesson_id: z.string(), item_ids: z.array(z.string()), objective_id: z.string().optional() }),
]);
export type Change = z.infer<typeof ChangeSchema>;

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    case "add_block": {
      const ref = nodeOf(next, change.section_id);
      if (ref.kind !== "section") throw new ChangeError(`"${change.section_id}" is not a section`);
      const section = ref.lesson.sections[ref.index]!;
      if (section.archived) throw new ChangeError(`section "${change.section_id}" is archived`);
      const id = change.block_id ?? nextInterventionId(next, section.id);
      if (findNode(next, id)) throw new ChangeError(`block "${id}" already exists`);
      const block: Block = { id, kind: "intervention", intervention: change.intervention, archived: false };
      section.blocks.splice(change.at ?? section.blocks.length, 0, block);
      break;
    }
    case "remove_block": {
      const ref = nodeOf(next, change.block_id);
      if (ref.kind !== "block") throw new ChangeError(`"${change.block_id}" is not a block`);
      ref.lesson.sections[ref.section]!.blocks.splice(ref.index, 1);
      break;
    }
    case "insert_block": {
      const ref = nodeOf(next, change.section_id);
      if (ref.kind !== "section") throw new ChangeError(`"${change.section_id}" is not a section`);
      const section = ref.lesson.sections[ref.index]!;
      if (section.archived) throw new ChangeError(`section "${change.section_id}" is archived`);
      if (findNode(next, change.block.id)) throw new ChangeError(`block "${change.block.id}" already exists`);
      section.blocks.splice(change.at ?? section.blocks.length, 0, structuredClone(change.block));
      break;
    }
    case "add_section": {
      const lesson = lessonOf(next, change.lesson_id);
      if (findNode(next, change.section.id)) throw new ChangeError(`"${change.section.id}" already exists`);
      lesson.sections.splice(change.at ?? lesson.sections.length, 0, structuredClone(change.section));
      for (const id of change.objectives ?? []) {
        const objective = next.objectives?.find((o) => o.id === id);
        if (!objective || objective.lesson !== lesson.id) throw new ChangeError(`no objective "${id}" in lesson "${lesson.id}"`);
        objective.sections.push(change.section.id);
      }
      break;
    }
    case "remove_section": {
      const ref = nodeOf(next, change.section_id);
      if (ref.kind !== "section") throw new ChangeError(`"${change.section_id}" is not a section`);
      ref.lesson.sections.splice(ref.index, 1);
      for (const objective of next.objectives ?? []) objective.sections = objective.sections.filter((s) => s !== change.section_id);
      break;
    }
    case "add_lesson": {
      if (findNode(next, change.lesson.id)) throw new ChangeError(`"${change.lesson.id}" already exists`);
      for (const p of change.lesson.prerequisites) lessonOf(next, p);
      next.lessons.splice(change.at ?? next.lessons.length, 0, structuredClone(change.lesson));
      next.objectives = [...(next.objectives ?? []), ...structuredClone(change.objectives)];
      next.misconceptions = [...next.misconceptions, ...structuredClone(change.misconceptions)];
      break;
    }
    case "remove_lesson": {
      const lesson = lessonOf(next, change.lesson_id);
      const dependent = next.lessons.find((l) => l.prerequisites.includes(lesson.id));
      if (dependent) throw new ChangeError(`"${dependent.id}" builds on "${lesson.id}"`);
      next.lessons = next.lessons.filter((l) => l.id !== lesson.id);
      if (next.objectives) next.objectives = next.objectives.filter((o) => o.lesson !== lesson.id);
      next.misconceptions = next.misconceptions.filter((m) => m.lesson !== lesson.id);
      break;
    }
    case "add_items": {
      const lesson = lessonOf(next, change.lesson_id);
      for (const item of change.items) {
        if (lesson.quiz.some((q) => q.id === item.id)) throw new ChangeError(`question "${item.id}" already exists`);
      }
      lesson.quiz.push(...structuredClone(change.items));
      if (change.objective) {
        if (next.objectives?.some((o) => o.id === change.objective!.id)) throw new ChangeError(`objective "${change.objective.id}" already exists`);
        next.objectives = [...(next.objectives ?? []), structuredClone(change.objective)];
      }
      break;
    }
    case "remove_items": {
      const lesson = lessonOf(next, change.lesson_id);
      lesson.quiz = lesson.quiz.filter((q) => !change.item_ids.includes(q.id));
      if (change.objective_id && next.objectives) next.objectives = next.objectives.filter((o) => o.id !== change.objective_id);
      break;
    }
  }
  return next;
}

/** The next free intervention block id in a section: `<section>/i1`, `/i2`… */
function nextInterventionId(snapshot: CourseSnapshot, sectionId: string): string {
  for (let n = 1; ; n++) {
    const id = `${sectionId}/i${n}`;
    if (!findNode(snapshot, id)) return id;
  }
}

/** The id add_block will give its block when applied to `snapshot`. */
export function addedBlockId(snapshot: CourseSnapshot, change: Extract<Change, { op: "add_block" }>): string {
  return change.block_id ?? nextInterventionId(snapshot, change.section_id);
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
    case "add_block":
      return { op: "remove_block", block_id: addedBlockId(before, change) };
    case "remove_block": {
      const ref = nodeOf(before, change.block_id);
      if (ref.kind !== "block") throw new ChangeError(`"${change.block_id}" is not a block`);
      const block = ref.lesson.sections[ref.section]!.blocks[ref.index]!;
      const section_id = ref.lesson.sections[ref.section]!.id;
      if (block.kind !== "intervention") return { op: "insert_block", section_id, block: structuredClone(block), at: ref.index };
      return { op: "add_block", section_id, intervention: block.intervention, block_id: block.id, at: ref.index };
    }
    case "insert_block":
      return { op: "remove_block", block_id: change.block.id };
    case "add_section":
      return { op: "remove_section", section_id: change.section.id };
    case "remove_section": {
      const ref = nodeOf(before, change.section_id);
      if (ref.kind !== "section") throw new ChangeError(`"${change.section_id}" is not a section`);
      const objectives = (before.objectives ?? []).filter((o) => o.sections.includes(change.section_id)).map((o) => o.id);
      return { op: "add_section", lesson_id: ref.lesson.id, section: structuredClone(ref.lesson.sections[ref.index]!), at: ref.index, objectives };
    }
    case "add_lesson":
      return { op: "remove_lesson", lesson_id: change.lesson.id };
    case "remove_lesson": {
      const lesson = lessonOf(before, change.lesson_id);
      return {
        op: "add_lesson",
        lesson: structuredClone(lesson),
        objectives: structuredClone((before.objectives ?? []).filter((o) => o.lesson === lesson.id)),
        misconceptions: structuredClone(before.misconceptions.filter((m) => m.lesson === lesson.id)),
        at: before.lessons.indexOf(lesson),
      };
    }
    case "add_items":
      return { op: "remove_items", lesson_id: change.lesson_id, item_ids: change.items.map((i) => i.id), ...(change.objective && { objective_id: change.objective.id }) };
    case "remove_items": {
      const lesson = lessonOf(before, change.lesson_id);
      const objective = change.objective_id ? before.objectives?.find((o) => o.id === change.objective_id) : undefined;
      return {
        op: "add_items",
        lesson_id: lesson.id,
        items: structuredClone(lesson.quiz.filter((q) => change.item_ids.includes(q.id))),
        ...(objective && { objective: structuredClone(objective) }),
      };
    }
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
    case "add_block":
      return "R0"; // additive, shown only to learners who show the misconception
    case "remove_block":
    case "insert_block":
    case "add_section":
    case "remove_section":
      return "R1"; // changes what every learner reads
    case "add_lesson":
    case "remove_lesson":
    case "add_items":
    case "remove_items":
      return "R2"; // a whole lesson, or the exam
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
    case "add_block":
    case "remove_block":
    case "insert_block":
    case "add_section":
    case "remove_section":
      return "minor"; // new or removed material; the path and the quiz are unchanged
    case "add_items":
    case "remove_items":
      return "minor"; // more questions to draw from; nobody's path changes
    case "add_lesson":
    case "remove_lesson":
      return "major"; // the path every learner follows
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
    case "add_block":
      return `add a ${describeIntervention(change.intervention)} to ${change.section_id}`;
    case "remove_block":
      return `remove ${change.block_id}`;
    case "insert_block":
      return `add a ${change.block.kind} block to ${change.section_id}`;
    case "add_section":
      return `add the section "${change.section.title}" to ${change.lesson_id}`;
    case "remove_section":
      return `remove ${change.section_id}`;
    case "add_lesson":
      return `add the lesson "${change.lesson.title}"`;
    case "remove_lesson":
      return `remove the lesson ${change.lesson_id}`;
    case "add_items":
      return `add ${change.items.length} question(s) to ${change.lesson_id}${change.objective ? ` for "${change.objective.statement}"` : ""}`;
    case "remove_items":
      return `remove ${change.item_ids.length} question(s) from ${change.lesson_id}`;
  }
}

const TEMPLATE_NAMES = { contrast: "contrast card", practice: "practice set", step_through: "step-through player" } as const;
export const describeIntervention = (intervention: Intervention) =>
  `${TEMPLATE_NAMES[intervention.template]} for "${intervention.targets}"`;

export { ChangeError };
