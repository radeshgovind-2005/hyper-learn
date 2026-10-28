import { wouldCreateCycle } from "./course/graph.js";
import type { PrereqGraph } from "./course/schema.js";
import type { Mutation, NodePerformance } from "./state.js";

const NEEDS_TARGET: ReadonlySet<Mutation["action"]> = new Set(["merge_nodes", "add_prerequisite", "remove_prerequisite"]);

export const graphFromPerformance = (data: readonly NodePerformance[]): PrereqGraph =>
  Object.fromEntries(data.map((node) => [node.node_id, node.prerequisites]));

/**
 * Deterministic checks a mutation must pass before any model reviews it: ids exist, the target is
 * set exactly when the action needs one, and the graph stays valid. Returns the problems (empty = valid).
 */
export function checkMutation(mutation: Mutation, data: readonly NodePerformance[]): string[] {
  const graph = graphFromPerformance(data);
  const { action, node_id, target_node_id } = mutation;
  const known = (id: string) => id in graph;
  const problems: string[] = [];

  if (!known(node_id)) problems.push(`node_id "${node_id}" is not a lesson in the data`);

  if (NEEDS_TARGET.has(action) && target_node_id === null) problems.push(`${action} needs a target_node_id`);
  if (!NEEDS_TARGET.has(action) && target_node_id !== null) problems.push(`${action} must have target_node_id = null`);

  if (target_node_id !== null && NEEDS_TARGET.has(action)) {
    if (!known(target_node_id)) problems.push(`target_node_id "${target_node_id}" is not a lesson in the data`);
    else if (target_node_id === node_id) problems.push("target_node_id must differ from node_id");
  }

  if (problems.length === 0 && target_node_id !== null) {
    const isPrereq = graph[node_id]!.includes(target_node_id);
    if (action === "add_prerequisite" && isPrereq) {
      problems.push(`"${target_node_id}" is already a prerequisite of "${node_id}"`);
    } else if (action === "add_prerequisite" && wouldCreateCycle(graph, node_id, target_node_id)) {
      problems.push(`making "${target_node_id}" a prerequisite of "${node_id}" would create a cycle`);
    } else if (action === "remove_prerequisite" && !isPrereq) {
      problems.push(`"${target_node_id}" is not a prerequisite of "${node_id}"`);
    }
  }

  return problems;
}
