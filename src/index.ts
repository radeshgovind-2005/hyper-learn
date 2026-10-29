import "./node/setup.js";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "./graph.js";
import { flushTraces, traceConfig } from "./observability.js";
import { scenarioPerformance } from "./simulation/index.js";
import { SCENARIOS } from "./simulation/scenarios.js";
import type { State, StateUpdate } from "./state.js";

const app = buildGraph();
const INVOKE_CONFIG = { recursionLimit: 15, ...traceConfig({ name: "demo" }) };

interface Demo {
  id: string;
  title: string;
  /** Built lazily, so running one demo doesn't simulate every scenario. */
  input: () => StateUpdate;
  summarize: (state: State) => void;
}

async function runDemo({ title, input, summarize }: Demo) {
  console.log(`\n${"═".repeat(60)}\n🚀 ${title}\n${"═".repeat(60)}`);
  const finalState = await app.invoke(input(), INVOKE_CONFIG);
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

const DEMOS: Demo[] = [
  {
    id: "assistant",
    title: "Learner question (Assistant + Tool loop)",
    input: () => ({
      input_type: "user_question",
      messages: [new HumanMessage("I keep failing the multi-agent quiz. What should I review first? Show me a diagram.")],
    }),
    summarize: (state) => console.log(state.messages.at(-1)?.content),
  },
  // One Curator demo per simulated scenario; `npm run eval` runs the same scenarios and scores them.
  ...SCENARIOS.map(
    (scenario): Demo => ({
      id: scenario.id,
      title: `Nightly cron — ${scenario.title}`,
      input: () => ({ input_type: "cron", performance_data: scenarioPerformance(scenario) }),
      summarize: printCuratorResult,
    }),
  ),
];

/** `npm start` runs every demo; `npm start -- missing-prereq` runs only the named ones. */
async function main() {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((id) => !DEMOS.some((demo) => demo.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown demo(s): ${unknown.join(", ")}. Available: ${DEMOS.map((d) => d.id).join(", ")}`);
  }

  const selected = requested.length > 0 ? DEMOS.filter((d) => requested.includes(d.id)) : DEMOS;
  for (const demo of selected) {
    await runDemo(demo);
  }
  await flushTraces();
}

main().catch((error: unknown) => {
  console.error("💥 Run failed:", error);
  process.exitCode = 1;
});
