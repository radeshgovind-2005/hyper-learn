import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { scenarioPerformance } from "../simulation/index.js";
import { getScenario, type Scenario, SCENARIOS } from "../simulation/scenarios.js";
import type { Mutation, NodePerformance } from "../state.js";
import { type AgentResult, runAgents } from "./agents.js";
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

interface ScenarioResult {
  scenario: string;
  expected: Scenario["expected"];
  data: NodePerformance[];
  reference: { mutation: Mutation; score: Score };
  agents?: AgentResult;
}

const SCORE_ICON: Record<Score, string> = { exact: "✅", right_lesson: "🟡", miss: "❌" };
const describe = (m?: { action: string; node_id: string | null; target_node_id: string | null; misconception_id: string | null }) =>
  m
    ? `${m.action}(${m.node_id ?? "any"}${m.target_node_id ? ` ← ${m.target_node_id}` : ""}` +
      `${m.misconception_id ? ` : ${m.misconception_id}` : ""})`
    : "—";

function printData(data: NodePerformance[]) {
  for (const node of data) {
    const top = node.gaps.map((m) => `${m.points_to} ${Math.round(m.share * 100)}%`).join(", ");
    const beliefs = node.misconceptions
      .map((m) => `${m.id} ${Math.round(m.share * 100)}% (${Math.round(m.confident * 100)}% sure)`)
      .join(", ");
    console.log(
      `  ${node.node_id.padEnd(18)} ${String(node.attempts).padStart(4)} attempts  fail ${node.fail_rate.toFixed(2)}` +
        `${node.low_sample ? " (low sample)" : ""}  wrong answers → ${top}`,
    );
    if (beliefs) console.log(`  ${"".padEnd(18)} beliefs: ${beliefs}`);
    if (node.excluded_items.length > 0) console.log(`  ${"".padEnd(18)} excluded broken items: ${node.excluded_items.join(", ")}`);
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
      result.agents = await runAgents(scenario.expected, data);
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
