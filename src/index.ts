import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import { app } from "./graph.js";
import type { NodePerformance, State, StateUpdate } from "./state.js";

const INVOKE_CONFIG = { recursionLimit: 15 };

interface Scenario {
  id: string;
  title: string;
  input: StateUpdate;
  summarize: (state: State) => void;
}

async function runScenario({ title, input, summarize }: Scenario) {
  console.log(`\n${"═".repeat(60)}\n🚀 ${title}\n${"═".repeat(60)}`);
  const finalState = await app.invoke(input, INVOKE_CONFIG);
  console.log(`\n📋 Result`);
  summarize(finalState);
}

const printCuratorResult = (state: State) =>
  console.log(
    JSON.stringify(
      {
        mutation: state.proposed_mutation,
        verdict: state.reflection_verdict,
        attempts: state.reflection_attempts,
      },
      null,
      2,
    ),
  );

/** One clear problem node: Closures fails far more than anything else. */
const CLEAR_PERFORMANCE_DATA: NodePerformance[] = [
  { node_id: "n1", title: "Functions", attempts: 210, fail_rate: 0.18, prerequisites: ["n0"] },
  { node_id: "n2", title: "Closures", attempts: 184, fail_rate: 0.72, prerequisites: ["n0", "n1"] },
  { node_id: "n3", title: "Closures Exercise: Counter Factory", attempts: 95, fail_rate: 0.41, prerequisites: ["n2"] },
  { node_id: "n5", title: "Recursion", attempts: 160, fail_rate: 0.27, prerequisites: ["n1"] },
];

/**
 * Deliberately ambiguous, to exercise the reject → retry loop:
 * - n4 has the highest fail rate but only 12 attempts (too few to trust).
 * - n2 is the highest well-sampled node, so "split n2" is the tempting answer…
 * - …but its prerequisite n1 is failing too, and so is n5, which also depends on n1.
 *   The shared upstream cause points at n1, not n2.
 */
const AMBIGUOUS_PERFORMANCE_DATA: NodePerformance[] = [
  { node_id: "n0", title: "Variables & Scope", attempts: 220, fail_rate: 0.12, prerequisites: [] },
  { node_id: "n1", title: "Functions", attempts: 205, fail_rate: 0.61, prerequisites: ["n0"] },
  { node_id: "n2", title: "Closures", attempts: 178, fail_rate: 0.68, prerequisites: ["n0", "n1"] },
  { node_id: "n3", title: "Closures Exercise: Counter Factory", attempts: 90, fail_rate: 0.64, prerequisites: ["n2"] },
  { node_id: "n4", title: "Higher-Order Functions", attempts: 12, fail_rate: 0.83, prerequisites: ["n1", "n2"] },
  { node_id: "n5", title: "Recursion", attempts: 150, fail_rate: 0.58, prerequisites: ["n1"] },
];

const SCENARIOS: Scenario[] = [
  {
    id: "assistant",
    title: "Scenario 1 — Learner question (Assistant + Tool loop)",
    input: {
      input_type: "user_question",
      messages: [
        new HumanMessage("I keep failing the closures material. What should I review first? Show me a diagram."),
      ],
    },
    summarize: (state) => console.log(state.messages.at(-1)?.content),
  },
  {
    id: "curator",
    title: "Scenario 2 — Nightly cron, clear signal (Curator + Reflection loop)",
    input: { input_type: "cron", performance_data: CLEAR_PERFORMANCE_DATA },
    summarize: printCuratorResult,
  },
  {
    id: "curator-ambiguous",
    title: "Scenario 3 — Nightly cron, ambiguous signal (reject → retry loop)",
    input: { input_type: "cron", performance_data: AMBIGUOUS_PERFORMANCE_DATA },
    summarize: printCuratorResult,
  },
];

/** `npm start` runs every scenario; `npm start -- curator-ambiguous` runs only the named ones. */
async function main() {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  }

  const selected = requested.length > 0 ? SCENARIOS.filter((s) => requested.includes(s.id)) : SCENARIOS;
  for (const scenario of selected) {
    await runScenario(scenario);
  }
}

main().catch((error: unknown) => {
  console.error("💥 Run failed:", error);
  process.exitCode = 1;
});
