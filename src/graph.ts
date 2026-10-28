import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { type AssistantModel, createAssistantNode } from "./nodes/assistant.js";
import { createCuratorNode, type CuratorModel } from "./nodes/curator.js";
import { createReflectionNode, type ReflectionModel, routeFromReflection } from "./nodes/reflection.js";
import { routeFromSupervisor, supervisorNode } from "./nodes/supervisor.js";
import { GraphState } from "./state.js";
import { assistantTools } from "./tools/index.js";

/** Models each LLM node uses. Omitted ones fall back to the real configured models. */
export interface GraphModels {
  assistant: AssistantModel;
  curator: CuratorModel;
  reflection: ReflectionModel;
}

/**
 *            ┌──────────── supervisor ────────────┐
 *            ▼                                    ▼
 *   assistant ⇄ tools                    curator → reflection
 *            │                              ▲          │
 *            ▼                              └─ reject ─┤
 *           END                                        ▼ approve / max attempts
 *                                                     END
 */
export function buildGraph(models: Partial<GraphModels> = {}) {
  return (
    new StateGraph(GraphState)
      .addNode("supervisor", supervisorNode)
      .addNode("assistant", createAssistantNode(models.assistant))
      .addNode("tools", new ToolNode(assistantTools))
      .addNode("curator", createCuratorNode(models.curator))
      .addNode("reflection", createReflectionNode(models.reflection))

      .addEdge(START, "supervisor")
      .addConditionalEdges("supervisor", routeFromSupervisor, ["assistant", "curator"])

      // Learner Assistant: loop through tools until the model stops calling them.
      .addConditionalEdges("assistant", toolsCondition, ["tools", END])
      .addEdge("tools", "assistant")

      // Curator: every proposal is reviewed; rejected ones loop back (bounded).
      .addEdge("curator", "reflection")
      .addConditionalEdges("reflection", routeFromReflection, ["curator", END])

      .compile()
  );
}
