import { ancestorsOf } from "../course/graph.js";
import { graphFromPerformance } from "../mutations.js";
import type { Mutation, NodePerformance } from "../state.js";

/** A reliable lesson failing at least this often is a problem. Mirrored in the Curator's instructions. */
export const PROBLEM_FAIL_RATE = 0.35;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * A rule-based Curator, used as a reference: if it can't solve a scenario, the data doesn't contain
 * the fault and the scenario is broken, not the agent. It follows each problem lesson's largest
 * misconception upstream to the root cause.
 */
export function referenceCurator(data: readonly NodePerformance[]): Mutation {
  const graph = graphFromPerformance(data);
  const problems = data
    .filter((node) => !node.low_sample && node.fail_rate >= PROBLEM_FAIL_RATE)
    .sort((a, b) => b.fail_rate - a.fail_rate);

  for (const node of problems) {
    const top = node.misconceptions[0];
    const evidence = `${node.node_id} fails ${percent(node.fail_rate)} of ${node.attempts} attempts`;

    if (!top || top.points_to === node.node_id) {
      return {
        action: "split_node",
        node_id: node.node_id,
        target_node_id: null,
        reason: `${evidence}; ${percent(top?.share ?? 1)} of wrong answers are gaps inside the lesson itself.`,
      };
    }
    // Wrong answers point at something it already depends on: the problem is upstream.
    if (ancestorsOf(graph, node.node_id).has(top.points_to)) continue;

    return {
      action: "add_prerequisite",
      node_id: node.node_id,
      target_node_id: top.points_to,
      reason: `${evidence}; ${percent(top.share)} of wrong answers reveal a gap in ${top.points_to}, which is not a prerequisite.`,
    };
  }

  const highest = [...data].sort((a, b) => b.fail_rate - a.fail_rate)[0];
  if (!highest) throw new Error("referenceCurator needs performance data");
  return {
    action: "flag_for_review",
    node_id: highest.node_id,
    target_node_id: null,
    reason: `No reliable lesson fails ${percent(PROBLEM_FAIL_RATE)} or more; highest is ${highest.node_id} at ${percent(highest.fail_rate)}.`,
  };
}
