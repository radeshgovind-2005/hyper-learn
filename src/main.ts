// mic-test.ts
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import * as dotenv from "dotenv";

dotenv.config();

// 1. Define a minimal State
const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  route: Annotation<string>(),
});

// 2. Configure the Local Model
// Connecting to your LM Studio / llama.cpp server on port 9931
const localModel = new ChatOpenAI({
  configuration: {
    baseURL: "http://localhost:9931/v1",
  },
  apiKey: "not-needed-locally",
  modelName: "meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M", // Adjust if your server expects a different model string
  temperature: 0.1,
});

// 3. Define Nodes
const supervisorNode = async (state: typeof GraphState.State) => {
  console.log("🟢 [Supervisor] I see a user message. Routing to Assistant...");
  return { route: "assistant" };
};

const assistantNode = async (state: typeof GraphState.State) => {
  console.log("🔵 [Assistant] Thinking... (calling local model)");
  const response = await localModel.invoke(state.messages);
  return { messages: [response] };
};

// 4. Build and Compile the Graph
const workflow = new StateGraph(GraphState)
  .addNode("supervisor", supervisorNode)
  .addNode("assistant", assistantNode)
  
  .addEdge(START, "supervisor")
  
  // Conditional routing based on state.route
  .addConditionalEdges("supervisor", (state) => state.route, {
    assistant: "assistant",
  })
  
  .addEdge("assistant", END);

const app = workflow.compile();

// 5. Run the Test
async function runMicTest() {
  console.log("🚀 Starting Mic Test...\n");
  
  const finalState = await app.invoke({
    messages: [new HumanMessage("Hello! Reply with exactly: 'Mic test successful! LangGraph is connected to my local model.'")],
  });

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  console.log("\n🤖 Model Output:\n", lastMessage.content);
}

runMicTest().catch(console.error);