import type { ExpectedMutation } from "../simulation/scenarios.js";
import type { Mutation } from "../state.js";

/** exact = the planted fault's fix; right_lesson = right lesson, wrong action or target; miss = anything else. */
export type Score = "exact" | "right_lesson" | "miss";

export function scoreMutation(expected: ExpectedMutation, actual: Mutation | undefined): Score {
  if (!actual) return "miss";
  const nodeMatches = expected.node_id === null || actual.node_id === expected.node_id;
  if (
    actual.action === expected.action &&
    nodeMatches &&
    actual.target_node_id === expected.target_node_id &&
    actual.misconception_id === expected.misconception_id
  ) {
    return "exact";
  }
  return expected.node_id !== null && actual.node_id === expected.node_id ? "right_lesson" : "miss";
}
