import { buildGraph } from "../graph.js";
import { traceConfig } from "../observability.js";
import type { ExpectedMutation } from "../simulation/scenarios.js";
import type { Mutation, NodePerformance, State } from "../state.js";
import { type Score, scoreMutation } from "./score.js";

export interface AgentResult {
  /** The Curator's last proposal, approved or not. Kept even if a later step failed. */
  proposal?: Mutation;
  approved: boolean;
  attempts: number;
  critique?: string;
  /** Score of what would actually be applied: the proposal, only if Reflection approved it. */
  score: Score;
  /** Score of the last proposal regardless of approval; separates Curator mistakes from Reflection mistakes. */
  proposal_score: Score;
  duration_ms: number;
  error?: string;
}

type Graph = ReturnType<typeof buildGraph>;

/**
 * Runs Curator → code checks → Reflection on one scenario's data and scores the outcome.
 * The graph's state is followed step by step, so if a step fails (e.g. Reflection runs out of
 * context) the result still records how far the agents got, including the Curator's proposal.
 */
export async function runAgents(
  expected: ExpectedMutation,
  data: NodePerformance[],
  graph: Graph = buildGraph(),
  scenario?: string,
): Promise<AgentResult> {
  const started = Date.now();
  let last: State | undefined;
  let error: string | undefined;

  try {
    const steps = await graph.stream(
      { input_type: "cron", performance_data: data },
      { streamMode: "values", recursionLimit: 15, ...traceConfig({ name: "eval", ...(scenario && { scenario }) }) },
    );
    for await (const state of steps) last = state as State;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const proposal = last?.proposed_mutation;
  const verdict = error === undefined ? last?.reflection_verdict : undefined;
  const approved = verdict?.approved ?? false;

  return {
    ...(proposal && { proposal }),
    approved,
    attempts: last?.reflection_attempts ?? 0,
    ...(verdict && { critique: verdict.critique }),
    score: scoreMutation(expected, approved ? proposal : undefined),
    proposal_score: scoreMutation(expected, proposal),
    duration_ms: Date.now() - started,
    ...(error !== undefined && { error }),
  };
}
