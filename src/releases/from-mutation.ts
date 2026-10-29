import type { Mutation } from "../state.js";
import type { Change } from "./changes.js";

/**
 * The changes a Curator proposal stands for, or why it can't be applied. Proposals that need new
 * content (a split, a merge, an intervention) can't be applied until an author writes that content.
 */
export function changesFor(mutation: Mutation): { changes: Change[] } | { reason: string } {
  const { action, node_id, target_node_id } = mutation;
  switch (action) {
    case "add_prerequisite":
    case "remove_prerequisite":
      if (target_node_id === null) return { reason: `${action} needs a target` };
      return { changes: [{ op: action, lesson: node_id, prerequisite: target_node_id }] };
    case "flag_for_review":
      return { reason: "flagged for human review; nothing to apply" };
    case "split_node":
    case "merge_nodes":
    case "add_intervention":
      return { reason: `${action} needs authored content, which this harness can't apply yet` };
  }
}
