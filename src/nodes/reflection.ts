import { END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getStructuredModel, type Invokable } from "../models.js";
import {
  getPrompt,
  MAX_CURATOR_ATTEMPTS,
  type ReflectionVerdict,
  ReflectionVerdictSchema,
  type State,
  type StateUpdate,
} from "../state.js";
import { logNode } from "../utils/logger.js";

export type ReflectionModel = Invokable<ReflectionVerdict>;

export const createReflectionModel = (): ReflectionModel =>
  getStructuredModel(ReflectionVerdictSchema, "review_mutation");

export function createReflectionNode(model: ReflectionModel = createReflectionModel()) {
  return async function reflectionNode(state: State): Promise<StateUpdate> {
    if (!state.proposed_mutation) throw new Error("Reflection reached without a proposed mutation");

    logNode("reflection", "Reviewing proposed mutation...");
    const verdict = await model.invoke([
      new SystemMessage(getPrompt("reflection")),
      new HumanMessage(
        `Performance data:\n${JSON.stringify(state.performance_data)}\n\n` +
          `Proposed mutation:\n${JSON.stringify(state.proposed_mutation)}`,
      ),
    ]);

    logNode("reflection", verdict.approved ? "✅ APPROVED" : "❌ REJECTED", verdict.critique);
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
