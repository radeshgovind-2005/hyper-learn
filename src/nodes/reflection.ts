import { END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAgent, getSystemPrompt } from "../agents.js";
import { defaultModels, type Invokable, type ModelProvider } from "../models.js";
import { checkMutation } from "../mutations.js";
import {
  formatPerformanceData,
  MAX_CURATOR_ATTEMPTS,
  type ReflectionVerdict,
  ReflectionVerdictSchema,
  type State,
  type StateUpdate,
} from "../state.js";
import { logNode } from "../utils/logger.js";

export type ReflectionModel = Invokable<ReflectionVerdict>;

export const createReflectionModel = (provider: ModelProvider = defaultModels()): ReflectionModel =>
  provider.structured(ReflectionVerdictSchema, "review_mutation", getAgent("reflection").model);

/** A rejection built from failed code checks, in the same line format the reviewer model uses. */
const codeCheckVerdict = (problems: string[]): ReflectionVerdict => ({
  approved: false,
  critique: [...problems.map((problem) => `CODE CHECK: FAIL — ${problem}`), "FIX: correct the ids and fields above."].join(
    "\n",
  ),
});

export function createReflectionNode(model: ReflectionModel = createReflectionModel()) {
  return async function reflectionNode(state: State): Promise<StateUpdate> {
    const mutation = state.proposed_mutation;
    if (!mutation) throw new Error("Reflection reached without a proposed mutation");

    // Cheap, exact checks first; the model is only asked about what needs judgement.
    const problems = checkMutation(mutation, state.performance_data);
    let verdict: ReflectionVerdict;
    if (problems.length > 0) {
      verdict = codeCheckVerdict(problems);
      logNode("reflection", "❌ REJECTED by code checks (model not called)", verdict.critique);
    } else {
      logNode("reflection", "Code checks passed. Reviewing proposed mutation...");
      verdict = await model.invoke([
        new SystemMessage(getSystemPrompt("reflection")),
        new HumanMessage(
          `${formatPerformanceData(state.performance_data)}\n\nProposed mutation:\n${JSON.stringify(mutation)}`,
        ),
      ]);
      logNode("reflection", verdict.approved ? "✅ APPROVED" : "❌ REJECTED", verdict.critique);
    }

    return { reflection_verdict: verdict, reflection_attempts: state.reflection_attempts + 1 };
  };
}

export function routeFromReflection(state: State): "curator" | typeof END {
  if (state.reflection_verdict?.approved) return END;

  if (state.reflection_attempts >= MAX_CURATOR_ATTEMPTS) {
    logNode("reflection", `Giving up after ${state.reflection_attempts} attempt(s) — mutation not applied.`);
    return END;
  }

  logNode("reflection", "Sending back to Curator for another attempt.");
  return "curator";
}
