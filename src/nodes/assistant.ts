import { type AIMessageChunk, SystemMessage } from "@langchain/core/messages";
import { getModel, type Invokable } from "../models.js";
import { getPrompt, type State, type StateUpdate } from "../state.js";
import { assistantTools } from "../tools/index.js";
import { logNode } from "../utils/logger.js";

export type AssistantModel = Invokable<AIMessageChunk>;

export const createAssistantModel = (): AssistantModel => getModel("fast").bindTools(assistantTools);

export function createAssistantNode(model: AssistantModel = createAssistantModel()) {
  return async function assistantNode(state: State): Promise<StateUpdate> {
    logNode("assistant", `Thinking over ${state.messages.length} message(s)...`);

    const response = await model.invoke([new SystemMessage(getPrompt("assistant")), ...state.messages]);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length > 0) {
      logNode("assistant", `Requesting tools: ${toolCalls.map((call) => call.name).join(", ")}`);
    } else {
      logNode("assistant", "Final answer ready.");
    }

    return { messages: [response] };
  };
}
