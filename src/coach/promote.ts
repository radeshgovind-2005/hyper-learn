import type { CourseSnapshot } from "../course/compile.js";
import type { EditRequest } from "../edit/types.js";
import type { ApproachCount } from "./bandit.js";
import type { Target } from "./diagnose.js";
import { type Approach, APPROACHES, sectionsFor } from "./repair.js";

// From one learner to the course: when one approach has fixed enough learners on the same target, the
// owner's insights offer "Promote to the course". Pressing it asks the course editor (the existing
// edit harness) to rewrite the section that teaches the target that way; the proposal is validated,
// given a risk tier, and applied or discarded by an editor like any other edit.

/** Learners an approach must have fixed on one target before it is proposed to everyone. */
export const PROMOTE_AFTER = 3;

export interface Promotion {
  approach: Approach;
  fixed: number;
  shown: number;
  section_id: string;
}

/** The approach to promote for a target, if one has fixed at least PROMOTE_AFTER learners (the best rate wins). */
export function promotionFor(snapshot: CourseSnapshot, target: Target, counts: readonly ApproachCount[]): Promotion | null {
  if (target.kind === "ready") return null;
  const eligible = counts.filter((c): c is ApproachCount & { approach: Approach } => (APPROACHES as readonly string[]).includes(c.approach) && c.fixed >= PROMOTE_AFTER);
  if (eligible.length === 0) return null;
  const best = eligible.sort((a, b) => b.fixed / b.shown - a.fixed / a.shown || b.fixed - a.fixed)[0]!;
  const section_id = sectionsFor(snapshot, target)[0];
  if (!section_id) return null;
  return { approach: best.approach, fixed: best.fixed, shown: best.shown, section_id };
}

const PRESET: Record<Approach, "worked_example" | "smaller_steps" | undefined> = { refute: undefined, worked_example: "worked_example", smaller_steps: "smaller_steps" };

const HOW: Record<Approach, string> = {
  refute: "Open by naming the mistaken idea the way learners hold it, say briefly why it seems right, then show with an example from the pages why it is wrong and state what is true.",
  worked_example: "Teach it through one worked example from the pages, step by step, saying why each step is taken.",
  smaller_steps: "Teach it in small numbered steps, one idea per step, defining each term the first time it appears.",
};

/** The owner edit a promotion asks for: tune the section that teaches the target, the way that worked. */
export function promotionRequest(label: string, promotion: Promotion): EditRequest {
  const preset = PRESET[promotion.approach];
  const instruction = `Learners stuck on "${label.slice(0, 200)}" were fixed by personal lessons written this way (${promotion.fixed} of ${promotion.shown} learners). Rewrite this section for everyone the same way. ${HOW[promotion.approach]}`;
  return { kind: "tune", section_id: promotion.section_id, ...(preset && { preset }), instruction: instruction.slice(0, 2_000) };
}
