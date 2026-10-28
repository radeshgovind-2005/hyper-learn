import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { assistantNode } from "./nodes/assistant.js";
import { curatorNode } from "./nodes/curator.js";
import { reflectionNode, routeFromReflection } from "./nodes/reflection.js";
import { routeFromSupervisor, supervisorNode } from "./nodes/supervisor.js";
import { GraphState } from "./state.js";
import { assistantTools } from "./tools/index.js";

/**
 *            ┌──────────── supervisor ────────────┐
 *            ▼                                    ▼
 *   assistant ⇄ tools                    curator → reflection
 *            │                              ▲          │
 *            ▼                              └─ reject ─┤
 *           END                                        ▼ approve / max attempts
 *                                                     END
 */
const workflow = new StateGraph(GraphState)
  .addNode("supervisor", supervisorNode)
  .addNode("assistant", assistantNode)
  .addNode("tools", new ToolNode(assistantTools))
  .addNode("curator", curatorNode)
  .addNode("reflection", reflectionNode)

  .addEdge(START, "supervisor")
  .addConditionalEdges("supervisor", routeFromSupervisor, ["assistant", "curator"])

  // Learner Assistant: loop through tools until the model stops calling them.
  .addConditionalEdges("assistant", toolsCondition, ["tools", END])
  .addEdge("tools", "assistant")

  // Curator: every proposal is reviewed; rejected ones loop back (bounded).
  .addEdge("curator", "reflection")
  .addConditionalEdges("reflection", routeFromReflection, ["curator", END]);

export const app = workflow.compile();
