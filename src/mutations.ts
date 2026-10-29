import { wouldCreateCycle } from "./course/graph.js";
import type { PrereqGraph } from "./course/schema.js";
import type { Mutation, NodePerformance } from "./state.js";

const NEEDS_TARGET: ReadonlySet<Mutation["action"]> = new Set(["merge_nodes", "add_prerequisite", "remove_prerequisite"]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True if `text` states `rate` as a decimal ("0.6" or "0.60") or a percentage ("60%"),
 * not merely as part of a longer number ("0.65", "160%"; for a rate of 0, "0.5").
 */
export function citesRate(text: string, rate: number): boolean {
  const forms = [String(rate), rate.toFixed(2)].map((form) => `(?<![\\d.])${escapeRegExp(form)}(?!\\.?\\d)`);
  forms.push(`(?<![\\d.])${Math.round(rate * 100)}\\s?%`);
  return new RegExp(forms.join("|")).test(text);
}

export const graphFromPerformance = (data: readonly NodePerformance[]): PrereqGraph =>
  Object.fromEntries(data.map((node) => [node.node_id, node.prerequisites]));

/**
 * Deterministic checks a mutation must pass before any model reviews it: ids exist, the target is
 * set exactly when the action needs one, the graph stays valid, and the reason cites the target
 * lesson's real fail rate. Returns the problems (empty = valid).
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

  const { misconception_id } = mutation;
  if (action === "add_intervention") {
    const named = data.find((node) => node.node_id === node_id)?.misconceptions ?? [];
    if (misconception_id === null) problems.push("add_intervention needs a misconception_id");
    else if (!named.some((m) => m.id === misconception_id && m.points_to === node_id)) {
      problems.push(`"${misconception_id}" is not a misconception of "${node_id}" in the data`);
    }
  } else if (misconception_id !== null) {
    problems.push(`${action} must have misconception_id = null`);
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

  const target = data.find((node) => node.node_id === node_id);
  if (target && !citesRate(mutation.reason, target.fail_rate)) {
    problems.push(`reason must cite ${node_id}'s fail_rate from the data (${target.fail_rate})`);
  }

  return problems;
}
