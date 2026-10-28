import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAgent, getSystemPrompt, renderTemplate } from "../agents.js";
import { getStructuredModel, type Invokable } from "../models.js";
import { type Mutation, MutationSchema, type State, type StateUpdate } from "../state.js";
import { logNode } from "../utils/logger.js";

export type CuratorModel = Invokable<Mutation>;

export const createCuratorModel = (): CuratorModel =>
  getStructuredModel(MutationSchema, "propose_mutation", getAgent("curator").model);

export function createCuratorNode(model: CuratorModel = createCuratorModel()) {
  return async function curatorNode(state: State): Promise<StateUpdate> {
    const attempt = state.reflection_attempts + 1;
    logNode("curator", `Analysing ${state.performance_data.length} node(s) — attempt ${attempt}`);

    const messages = [
      new SystemMessage(getSystemPrompt("curator")),
      new HumanMessage(`Performance data:\n${JSON.stringify(state.performance_data)}`),
    ];

    // On a retry, feed back the rejected proposal and the reviewer's critique.
    const { proposed_mutation, reflection_verdict } = state;
    if (proposed_mutation && reflection_verdict && !reflection_verdict.approved) {
      messages.push(
        new HumanMessage(
          renderTemplate("curator", "retry", {
            mutation: JSON.stringify(proposed_mutation),
            critique: reflection_verdict.critique,
          }),
        ),
      );
    }

    const mutation = await model.invoke(messages);
    logNode("curator", "Proposed mutation:", mutation);

    return { proposed_mutation: mutation };
  };
}
