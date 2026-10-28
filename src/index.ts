import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import { app } from "./graph.js";
import type { NodePerformance, State, StateUpdate } from "./state.js";

const INVOKE_CONFIG = { recursionLimit: 15 };

async function runScenario(title: string, input: StateUpdate, summarize: (state: State) => void) {
  console.log(`\n${"═".repeat(60)}\n🚀 ${title}\n${"═".repeat(60)}`);
  const finalState = await app.invoke(input, INVOKE_CONFIG);
  console.log(`\n📋 Result`);
  summarize(finalState);
}

const MOCK_PERFORMANCE_DATA: NodePerformance[] = [
  { node_id: "n1", title: "Functions", attempts: 210, fail_rate: 0.18 },
  { node_id: "n2", title: "Closures", attempts: 184, fail_rate: 0.72 },
  { node_id: "n3", title: "Closures Exercise: Counter Factory", attempts: 95, fail_rate: 0.41 },
  { node_id: "n5", title: "Recursion", attempts: 160, fail_rate: 0.27 },
];

async function main() {
  await runScenario(
    "Scenario 1 — Learner question (Assistant + Tool loop)",
    {
      input_type: "user_question",
      messages: [
        new HumanMessage(
          "I keep failing the closures material. What should I review first? Show me a diagram.",
        ),
      ],
    },
    (state) => console.log(state.messages.at(-1)?.content),
  );

  await runScenario(
    "Scenario 2 — Nightly cron (Curator + Reflection loop)",
    { input_type: "cron", performance_data: MOCK_PERFORMANCE_DATA },
    (state) =>
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
      ),
  );
}

main().catch((error: unknown) => {
  console.error("💥 Run failed:", error);
  process.exitCode = 1;
});
