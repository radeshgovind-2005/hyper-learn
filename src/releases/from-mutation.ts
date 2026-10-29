import type { Draft, Mutation } from "../state.js";
import type { Change } from "./changes.js";

/**
 * The changes a Curator proposal stands for, or why it can't be applied. An intervention needs the
 * Author's approved draft; a split or merge needs content no agent writes yet.
 */
export function changesFor(mutation: Mutation, draft?: Draft): { changes: Change[] } | { reason: string } {
  const { action, node_id, target_node_id } = mutation;
  switch (action) {
    case "add_prerequisite":
    case "remove_prerequisite":
      if (target_node_id === null) return { reason: `${action} needs a target` };
      return { changes: [{ op: action, lesson: node_id, prerequisite: target_node_id }] };
    case "flag_for_review":
      return { reason: "flagged for human review; nothing to apply" };
    case "add_intervention":
      if (!draft) return { reason: "add_intervention needs an approved draft from the Author" };
      return { changes: [{ op: "add_block", section_id: draft.section_id, intervention: draft.intervention }] };
    case "split_node":
    case "merge_nodes":
      return { reason: `${action} needs authored lessons, which no agent writes yet` };
  }
}
