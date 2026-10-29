import type { LessonNode } from "../course/compile.js";
import type { Draft, Mutation, NodePerformance } from "../state.js";
import { overlap } from "./checks.js";
import { exemplarFor } from "./exemplars.js";
import { allowedTemplates } from "./templates.js";

/** The section whose text shares the most vocabulary with `text`. */
export function bestSection(lesson: LessonNode, text: string): string {
  const scored = lesson.sections
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      score: overlap(text, s.blocks.flatMap((b) => (b.kind !== "intervention" ? [b.markdown] : [])).join(" ")),
    }));
  return scored.reduce((best, s) => (s.score > best.score ? s : best), scored[0]!).id;
}

/**
 * The reference run's Author: it can't write, so it releases a hand-written exemplar for the
 * misconception, attached to the section that best matches the belief. Throws if there is none.
 */
export function referenceDraft(proposal: Mutation, data: readonly NodePerformance[], lessons: readonly LessonNode[]): Draft {
  if (proposal.action !== "add_intervention" || !proposal.misconception_id) throw new Error("needs an add_intervention proposal");
  const evidence = data
    .find((n) => n.node_id === proposal.node_id)
    ?.misconceptions.find((m) => m.id === proposal.misconception_id);
  const templates = allowedTemplates(evidence?.confident ?? 0);
  const intervention = exemplarFor(proposal.misconception_id, templates);
  if (!intervention) throw new Error(`No hand-written ${templates.join("/")} exemplar for "${proposal.misconception_id}"`);
  const lesson = lessons.find((l) => l.id === proposal.node_id)!;
  const text = intervention.template === "contrast" ? `${intervention.belief} ${intervention.what_actually_happens}` : JSON.stringify(intervention);
  return { section_id: bestSection(lesson, text), intervention };
}
