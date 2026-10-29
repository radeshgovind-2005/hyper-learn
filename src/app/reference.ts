import { referenceCurator } from "../eval/reference.js";
import type { GraphModels } from "../graph.js";
import { referenceDraft } from "../interventions/reference.js";
import type { Approver } from "../nodes/release.js";
import type { ReleaseStore } from "../releases/release.js";
import { injectedProposal } from "../simulation/index.js";
import type { Scenario } from "../simulation/scenarios.js";
import type { NodePerformance } from "../state.js";

const NO_MODEL_REVIEW = { approved: true, critique: "No model review in a reference run: code checks only." };

/**
 * Stand-ins for the agents when no model is available: the rule-based reference proposes (or, on
 * simulated data, the scenario's injected proposal), a hand-written exemplar stands in for the Author, and review only runs
 * the code checks. Everything after (release, approval, trial, decision) is the real harness.
 */
export function referenceModels(scenario: Scenario | undefined, data: readonly NodePerformance[], store: ReleaseStore): Partial<GraphModels> {
  const proposal = (scenario && injectedProposal(scenario, data)) ?? referenceCurator(data);
  return {
    curator: { invoke: async () => proposal },
    reflection: { invoke: async () => NO_MODEL_REVIEW },
    author: { invoke: async () => referenceDraft(proposal, data, store.live().snapshot.lessons) },
    reviewer: { invoke: async () => NO_MODEL_REVIEW },
  };
}

/** Autopilot's approver without a model: approves whatever reaches it (the ceiling is enforced in code before it). */
export const approveWithinCeiling: Approver = async (request) => ({ approved: true, note: `within autopilot's ceiling (${request.tier})` });
