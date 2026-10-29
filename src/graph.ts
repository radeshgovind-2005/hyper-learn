import { type BaseCheckpointSaver, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { getAgentTools } from "./agents.js";
import { type AssistantModel, createAssistantNode } from "./nodes/assistant.js";
import { createCuratorNode, type CuratorModel } from "./nodes/curator.js";
import { createReflectionNode, type ReflectionModel, routeFromReflection } from "./nodes/reflection.js";
import {
  createApprovalNode,
  createDecideNode,
  createMeasureNode,
  createPlanReleaseNode,
  type Harness,
  routeFromApproval,
} from "./nodes/release.js";
import { routeFromSupervisor, supervisorNode } from "./nodes/supervisor.js";
import { GraphState, type State, type StateUpdate } from "./state.js";

/** Models each LLM node uses. Omitted ones fall back to the real configured models. */
export interface GraphModels {
  assistant: AssistantModel;
  curator: CuratorModel;
  reflection: ReflectionModel;
}

export interface GraphOptions {
  /** With a harness, an approved proposal is released, measured and kept or reverted. Without one, the run ends at approval. */
  harness?: Harness;
  /** Required when the harness may pause for human approval (interrupt). */
  checkpointer?: BaseCheckpointSaver;
}

/**
 *            ┌──────────── supervisor ────────────┐
 *            ▼                                    ▼
 *   assistant ⇄ tools                    curator → reflection
 *            │                              ▲          │
 *            ▼                              └─ reject ─┤
 *           END                                        ▼ approve / max attempts
 *                                     END ◀─ (no harness, or not approved)
 *                                                      │ approved, with a harness
 *                                                      ▼
 *                plan_release → approve (human interrupt or autopilot) → measure → decide → END
 */
export function buildGraph(models: Partial<GraphModels> = {}, { harness, checkpointer }: GraphOptions = {}) {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor", supervisorNode)
    .addNode("assistant", createAssistantNode(models.assistant))
    .addNode("tools", new ToolNode(getAgentTools("assistant")))
    .addNode("curator", createCuratorNode(models.curator))
    .addNode("reflection", createReflectionNode(models.reflection));

  const afterReflection = (state: State) => {
    const next = routeFromReflection(state);
    return next === END && harness && state.reflection_verdict?.approved ? "plan_release" : next;
  };
  // Without a harness the release nodes are unreachable; they exist so the graph has one shape.
  const unavailable = async (): Promise<StateUpdate> => {
    throw new Error("This graph was built without a release harness");
  };

  return (
    graph
      .addNode("plan_release", harness ? createPlanReleaseNode(harness) : unavailable)
      .addNode("approve", harness ? createApprovalNode(harness) : unavailable)
      .addNode("measure", harness ? createMeasureNode(harness) : unavailable)
      .addNode("decide", harness ? createDecideNode(harness) : unavailable)

      .addEdge(START, "supervisor")
      .addConditionalEdges("supervisor", routeFromSupervisor, ["assistant", "curator"])

      // Learner Assistant: loop through tools until the model stops calling them.
      .addConditionalEdges("assistant", toolsCondition, ["tools", END])
      .addEdge("tools", "assistant")

      // Curator: every proposal is reviewed; rejected ones loop back (bounded).
      .addEdge("curator", "reflection")
      .addConditionalEdges("reflection", afterReflection, ["curator", "plan_release", END])

      // Release harness: an approved proposal becomes a candidate release, is approved by a human or
      // autopilot, runs as a trial, and is kept or reverted on its measured outcome.
      .addConditionalEdges("plan_release", (state: State) => (state.candidate ? "approve" : END), ["approve", END])
      .addConditionalEdges("approve", routeFromApproval, ["measure", END])
      .addEdge("measure", "decide")
      .addEdge("decide", END)
      .compile({ checkpointer })
  );
}
