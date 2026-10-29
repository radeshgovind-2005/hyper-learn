import { type AIMessageChunk, SystemMessage } from "@langchain/core/messages";
import { getAgent, getAgentTools, getSystemPrompt } from "../agents.js";
import { defaultModels, type Invokable, type ModelProvider } from "../models.js";
import type { State, StateUpdate } from "../state.js";
import { logNode } from "../utils/logger.js";

export type AssistantModel = Invokable<AIMessageChunk>;

export const createAssistantModel = (provider: ModelProvider = defaultModels()): AssistantModel =>
  provider.chat(getAgent("assistant").model).bindTools(getAgentTools("assistant"));

export function createAssistantNode(model: AssistantModel = createAssistantModel()) {
  return async function assistantNode(state: State): Promise<StateUpdate> {
    logNode("assistant", `Thinking over ${state.messages.length} message(s)...`);

    const response = await model.invoke([new SystemMessage(getSystemPrompt("assistant")), ...state.messages]);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length > 0) {
      logNode("assistant", `Requesting tools: ${toolCalls.map((call) => call.name).join(", ")}`);
    } else {
      logNode("assistant", "Final answer ready.");
    }

    return { messages: [response] };
  };
}
