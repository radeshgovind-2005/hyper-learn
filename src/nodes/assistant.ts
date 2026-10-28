import { SystemMessage } from "@langchain/core/messages";
import { getModel } from "../models.js";
import { getPrompt, type State, type StateUpdate } from "../state.js";
import { assistantTools } from "../tools/index.js";
import { logNode } from "../utils/logger.js";

const assistantModel = getModel("fast").bindTools(assistantTools);

export async function assistantNode(state: State): Promise<StateUpdate> {
  logNode("assistant", `Thinking over ${state.messages.length} message(s)...`);

  const response = await assistantModel.invoke([
    new SystemMessage(getPrompt("assistant")),
    ...state.messages,
  ]);

  const toolCalls = response.tool_calls ?? [];
  if (toolCalls.length > 0) {
    logNode("assistant", `Requesting tools: ${toolCalls.map((call) => call.name).join(", ")}`);
  } else {
    logNode("assistant", "Final answer ready.");
  }

  return { messages: [response] };
}
