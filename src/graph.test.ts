import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessageChunk, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { buildGraph } from "./graph.js";
import {
  MAX_CURATOR_ATTEMPTS,
  type Mutation,
  type NodePerformance,
  type ReflectionVerdict,
} from "./state.js";

/**
 * A fake model that returns `responses` in order and records every prompt it receives.
 * Calling it more often than scripted throws, so an unexpected extra loop fails the test.
 */
function scriptedModel<T>(responses: T[]) {
  const calls: BaseMessage[][] = [];
  return {
    calls,
    async invoke(messages: BaseMessage[]): Promise<T> {
      const response = responses[calls.length];
      calls.push(messages);
      if (response === undefined) throw new Error(`Unexpected model call #${calls.length}`);
      return response;
    },
  };
}

const textOf = (message: BaseMessage | undefined) =>
  typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);

const lessonData = (node_id: string, fail_rate: number, prerequisites: string[]): NodePerformance => ({
  node_id,
  title: node_id,
  attempts: 200,
  fail_rate,
  fail_rate_ci: [fail_rate - 0.05, fail_rate + 0.05],
  low_sample: false,
  prerequisites,
  misconceptions: [{ points_to: node_id, share: 1 }],
});

const PERFORMANCE_DATA: NodePerformance[] = [
  lessonData("n0", 0.1, []),
  lessonData("n1", 0.61, ["n0"]),
  lessonData("n2", 0.68, ["n0", "n1"]),
];

const mutation = (node_id: string): Mutation => ({
  action: "split_node",
  node_id,
  target_node_id: null,
  reason: `${node_id} fails too often`,
});

const APPROVE: ReflectionVerdict = { approved: true, critique: "1 TARGET: PASS — ok" };
const REJECT: ReflectionVerdict = { approved: false, critique: "2 ACTION: FAIL — n1 is the root cause\nFIX: target n1" };

/** Builds the graph with fakes for every model, so nothing ever reaches the network. */
function runCurator(curatorResponses: Mutation[], reflectionResponses: ReflectionVerdict[]) {
  const curator = scriptedModel(curatorResponses);
  const reflection = scriptedModel(reflectionResponses);
  const assistant = scriptedModel<AIMessageChunk>([]);
  const app = buildGraph({ curator, reflection, assistant });
  const result = app.invoke({ input_type: "cron", performance_data: PERFORMANCE_DATA });
  return { curator, reflection, assistant, result };
}

describe("curator → reflection loop", () => {
  it("ends after one round when the first proposal is approved", async () => {
    const { curator, reflection, assistant, result } = runCurator([mutation("n1")], [APPROVE]);
    const state = await result;

    assert.equal(curator.calls.length, 1);
    assert.equal(reflection.calls.length, 1);
    assert.equal(assistant.calls.length, 0, "cron input must not reach the assistant");
    assert.equal(state.reflection_attempts, 1);
    assert.deepEqual(state.reflection_verdict, APPROVE);
  });

  it("retries with the critique after a rejection, then ends on approval", async () => {
    const { curator, reflection, result } = runCurator([mutation("n2"), mutation("n1")], [REJECT, APPROVE]);
    const state = await result;

    assert.equal(curator.calls.length, 2);
    assert.equal(reflection.calls.length, 2);
    assert.equal(state.reflection_attempts, 2);
    assert.deepEqual(state.proposed_mutation, mutation("n1"));
    assert.deepEqual(state.reflection_verdict, APPROVE);

    // First attempt: system prompt + data only. Retry: adds the rejected proposal and critique.
    assert.equal(curator.calls[0]?.length, 2);
    const retryPrompt = textOf(curator.calls[1]?.at(-1));
    assert.match(retryPrompt, /REJECTED/);
    assert.ok(retryPrompt.includes(REJECT.critique), "retry prompt should include the critique");
    assert.ok(retryPrompt.includes(JSON.stringify(mutation("n2"))), "retry prompt should include the rejected proposal");

    // Reflection reviews the new proposal, not the rejected one.
    assert.match(textOf(reflection.calls[1]?.at(-1)), /"node_id":"n1"/);
  });

  it("rejects an invalid proposal with code checks, without calling the reviewer model", async () => {
    const invalid: Mutation = { ...mutation("n2"), action: "add_prerequisite", target_node_id: "n1" }; // already a prerequisite
    const { curator, reflection, result } = runCurator([invalid, mutation("n1")], [APPROVE]);
    const state = await result;

    assert.equal(curator.calls.length, 2);
    assert.equal(reflection.calls.length, 1, "only the valid proposal reaches the reviewer model");
    assert.equal(state.reflection_attempts, 2);
    assert.deepEqual(state.reflection_verdict, APPROVE);
    assert.match(textOf(curator.calls[1]?.at(-1)), /CODE CHECK: FAIL — "n1" is already a prerequisite of "n2"/);
  });

  it(`gives up after ${MAX_CURATOR_ATTEMPTS} rejected attempts`, async () => {
    const proposals = Array.from({ length: MAX_CURATOR_ATTEMPTS }, (_, i) => mutation(`n${i + 1}`));
    const rejections = Array.from({ length: MAX_CURATOR_ATTEMPTS }, () => REJECT);
    const { curator, reflection, result } = runCurator(proposals, rejections);
    const state = await result;

    // scriptedModel throws on an extra call, so reaching here also proves the loop stopped.
    assert.equal(curator.calls.length, MAX_CURATOR_ATTEMPTS);
    assert.equal(reflection.calls.length, MAX_CURATOR_ATTEMPTS);
    assert.equal(state.reflection_attempts, MAX_CURATOR_ATTEMPTS);
    assert.equal(state.reflection_verdict?.approved, false);
  });
});

describe("assistant ⇄ tools loop", () => {
  it("runs the requested tool and returns to the assistant", async () => {
    const assistant = scriptedModel([
      new AIMessageChunk({
        content: "",
        tool_calls: [{ id: "call_1", name: "query_hypergraph", args: { topic: "tool" }, type: "tool_call" }],
      }),
      new AIMessageChunk({ content: "Review The Agent Loop first." }),
    ]);
    const curator = scriptedModel<Mutation>([]);
    const reflection = scriptedModel<ReflectionVerdict>([]);
    const app = buildGraph({ assistant, curator, reflection });

    const state = await app.invoke({
      input_type: "user_question",
      messages: [new HumanMessage("What should I review before tool calling?")],
    });

    assert.equal(assistant.calls.length, 2);
    assert.equal(curator.calls.length + reflection.calls.length, 0, "questions must not reach the curator");

    // The second assistant call sees the real (mock-data) tool result.
    const toolResult = assistant.calls[1]?.at(-1);
    assert.ok(toolResult instanceof ToolMessage);
    assert.match(textOf(toolResult), /Tool Calling/);

    assert.equal(textOf(state.messages.at(-1)), "Review The Agent Loop first.");
  });
});
