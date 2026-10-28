import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildGraph } from "../graph.js";
import { scenarioPerformance } from "../simulation/index.js";
import { getScenario, type Scenario, SCENARIOS } from "../simulation/scenarios.js";
import type { Mutation, NodePerformance } from "../state.js";
import { referenceCurator } from "./reference.js";
import { type Score, scoreMutation } from "./score.js";

/**
 * Scores the Curator + Reflection agents on the simulated scenarios.
 *
 *   npm run eval                          all scenarios, reference and agents
 *   npm run eval -- missing-prereq        selected scenarios
 *   npm run eval -- --reference-only      just the rule-based reference (instant, no model)
 *
 * Writes reports/eval-<timestamp>.json after every scenario, so a long run that is cut off keeps its results.
 */

interface AgentResult {
  /** The Curator's last proposal, approved or not. */
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

interface ScenarioResult {
  scenario: string;
  expected: Scenario["expected"];
  data: NodePerformance[];
  reference: { mutation: Mutation; score: Score };
  agents?: AgentResult;
}

const SCORE_ICON: Record<Score, string> = { exact: "✅", right_lesson: "🟡", miss: "❌" };
const describe = (m?: { action: string; node_id: string | null; target_node_id: string | null }) =>
  m ? `${m.action}(${m.node_id ?? "any"}${m.target_node_id ? ` ← ${m.target_node_id}` : ""})` : "—";

function printData(data: NodePerformance[]) {
  for (const node of data) {
    const top = node.misconceptions.map((m) => `${m.points_to} ${Math.round(m.share * 100)}%`).join(", ");
    console.log(
      `  ${node.node_id.padEnd(18)} ${String(node.attempts).padStart(4)} attempts  fail ${node.fail_rate.toFixed(2)}` +
        `${node.low_sample ? " (low sample)" : ""}  wrong answers → ${top}`,
    );
  }
}

async function runAgents(scenario: Scenario, data: NodePerformance[]): Promise<AgentResult> {
  const started = Date.now();
  try {
    const state = await buildGraph().invoke({ input_type: "cron", performance_data: data }, { recursionLimit: 15 });
    const approved = state.reflection_verdict?.approved ?? false;
    return {
      ...(state.proposed_mutation && { proposal: state.proposed_mutation }),
      approved,
      attempts: state.reflection_attempts,
      ...(state.reflection_verdict && { critique: state.reflection_verdict.critique }),
      score: scoreMutation(scenario.expected, approved ? state.proposed_mutation : undefined),
      proposal_score: scoreMutation(scenario.expected, state.proposed_mutation),
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      approved: false,
      attempts: 0,
      score: "miss",
      proposal_score: "miss",
      duration_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const referenceOnly = args.includes("--reference-only");
  const ids = args.filter((arg) => !arg.startsWith("--"));
  const scenarios = ids.length > 0 ? ids.map(getScenario) : SCENARIOS;

  mkdirSync("reports", { recursive: true });
  const reportPath = `reports/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n${"═".repeat(70)}\n🧪 ${scenario.title}\n${"═".repeat(70)}\n${scenario.description}\n`);
    const data = scenarioPerformance(scenario);
    printData(data);

    const mutation = referenceCurator(data);
    const result: ScenarioResult = {
      scenario: scenario.id,
      expected: scenario.expected,
      data,
      reference: { mutation, score: scoreMutation(scenario.expected, mutation) },
    };
    console.log(`\n  expected   ${describe(scenario.expected)}`);
    console.log(`  reference  ${describe(mutation)} ${SCORE_ICON[result.reference.score]}`);

    if (!referenceOnly) {
      result.agents = await runAgents(scenario, data);
      const { agents } = result;
      const status = agents.error ? `error: ${agents.error}` : agents.approved ? "approved" : "not approved";
      console.log(
        `  agents     ${describe(agents.proposal)} ${SCORE_ICON[agents.score]} (${status}, ${agents.attempts} attempt(s), ` +
          `${Math.round(agents.duration_ms / 60_000)} min)`,
      );
    }

    results.push(result);
    writeFileSync(reportPath, JSON.stringify({ created: new Date().toISOString(), results }, null, 2));
  }

  console.log(`\n${"═".repeat(70)}\n📊 Summary\n${"═".repeat(70)}`);
  for (const r of results) {
    const agents = r.agents
      ? `${SCORE_ICON[r.agents.score]} ${r.agents.score} (proposal: ${r.agents.proposal_score})`
      : "skipped";
    console.log(`  ${r.scenario.padEnd(16)} reference ${SCORE_ICON[r.reference.score]}  agents ${agents}`);
  }
  console.log(`\n  Report: ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error("💥 Eval failed:", error);
  process.exitCode = 1;
});
