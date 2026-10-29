import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AIMessageChunk } from "@langchain/core/messages";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { referenceCurator } from "./eval/reference.js";
import { buildGraph } from "./graph.js";
import { compare, type Measurement, outcome } from "./measure/decide.js";
import type { Measurer } from "./measure/measure.js";
import { type ApprovalRequest, createApprovalNode, type Harness } from "./nodes/release.js";
import { MemoryReleaseStore, type Release } from "./releases/release.js";
import { scenarioPerformance, scenarioSnapshot } from "./simulation/index.js";
import { getScenario } from "./simulation/scenarios.js";
import { GraphState, type Mutation } from "./state.js";

const scenario = getScenario("missing-prereq");
const data = scenarioPerformance(scenario);
const proposal = referenceCurator(data); // add_prerequisite(multi-agent ← tool-calling)

/** A measurer that reports a fixed result and counts its calls. */
function fakeMeasurer(improved: boolean) {
  const calls: string[] = [];
  const measurer: Measurer = {
    async measure(_live, candidate): Promise<Measurement> {
      calls.push(candidate.version);
      return {
        source: "simulation",
        expectation: "improve",
        primary: compare("multi-agent", "fail_rate", outcome(300, 150), outcome(300, improved ? 30 : 150)),
        guardrails: [],
      };
    },
  };
  return { measurer, calls };
}

function setup(mode: Harness["mode"], curator: Mutation = proposal, improved = true) {
  const store = new MemoryReleaseStore(scenarioSnapshot(scenario));
  const { measurer, calls } = fakeMeasurer(improved);
  const approvals: ApprovalRequest[] = [];
  const harness: Harness = {
    store,
    measurer,
    mode,
    approver: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  };
  const app = buildGraph(
    {
      curator: { invoke: async () => curator },
      reflection: { invoke: async () => ({ approved: true, critique: "ok" }) },
      assistant: { invoke: async (): Promise<AIMessageChunk> => { throw new Error("assistant must not run"); } },
    },
    { harness, checkpointer: new MemorySaver() },
  );
  const config = { configurable: { thread_id: "t" } };
  const start = () => app.invoke({ input_type: "cron", performance_data: data }, config);
  const pending = async () => (await app.getState(config)).tasks.flatMap((t) => t.interrupts);
  const resume = (approved: boolean) => app.invoke(new Command({ resume: { approved } }), config);
  return { store, app, calls, approvals, start, pending, resume };
}

describe("release harness (HITL)", () => {
  it("pauses for a human before anything is stored, then releases a kept trial", async () => {
    const h = setup("hitl");
    await h.start();
    const [request] = await h.pending();
    assert.equal((request?.value as ApprovalRequest).version, "2.0.0-trial.1");
    assert.deepEqual((request?.value as ApprovalRequest).changes, ["multi-agent now requires tool-calling"]);
    assert.equal(h.store.all().length, 1, "nothing stored while waiting");
    assert.equal(h.calls.length, 0);

    const state = await h.resume(true);
    assert.equal(state.trial_decision?.verdict, "keep");
    assert.equal(state.live_version, "2.0.0");
    assert.deepEqual(h.calls, ["2.0.0-trial.1"]);
    assert.equal(h.store.get("2.0.0-trial.1")?.approval?.by, "human");
  });

  it("records a rejection and never measures it", async () => {
    const h = setup("hitl");
    await h.start();
    const state = await h.resume(false);
    assert.equal(state.approval?.approved, false);
    assert.equal(h.store.get("2.0.0-trial.1")?.status, "rejected");
    assert.equal(h.store.live().version, "1.0.0");
    assert.equal(h.calls.length, 0);
  });

  it("reverts a trial whose measurement shows no improvement", async () => {
    const h = setup("hitl", proposal, false);
    await h.start();
    const state = await h.resume(true);
    assert.equal(state.trial_decision?.verdict, "revert");
    assert.equal(h.store.get("2.0.0-trial.1")?.status, "reverted");
    assert.equal(h.store.live().version, "1.0.0");
  });

  it("releases nothing for a flag_for_review proposal", async () => {
    const flag: Mutation = { ...proposal, action: "flag_for_review", target_node_id: null };
    const h = setup("hitl", flag);
    const state = await h.start();
    assert.deepEqual(await h.pending(), []);
    assert.match(state.release_problems?.join() ?? "", /flagged for human review/);
    assert.equal(h.store.all().length, 1);
  });
});

describe("release harness (autopilot)", () => {
  it("approves within its ceiling without interrupting", async () => {
    const h = setup("autopilot");
    const state = await h.start();
    assert.deepEqual(await h.pending(), []);
    assert.equal(h.approvals.length, 1);
    assert.equal(state.approval?.by, "autopilot");
    assert.equal(state.live_version, "2.0.0");
  });

  it("escalates an R2 change to a human, whatever the approver would say", async () => {
    const store = new MemoryReleaseStore(scenarioSnapshot(scenario));
    let approverCalled = false;
    const node = createApprovalNode({
      store,
      measurer: fakeMeasurer(true).measurer,
      mode: "autopilot",
      approver: async () => {
        approverCalled = true;
        return { approved: true };
      },
    });
    const app = new StateGraph(GraphState).addNode("approve", node).addEdge(START, "approve").addEdge("approve", END).compile({
      checkpointer: new MemorySaver(),
    });
    const r2: Release = {
      ...store.live(),
      version: "2.0.0-trial.1",
      parent: "1.0.0",
      status: "trial",
      tier: "R2",
      changes: [{ op: "archive_node", node_id: "reflection" }],
    };
    const config = { configurable: { thread_id: "r2" } };
    await app.invoke({ input_type: "cron", candidate: r2 }, config);
    const [request] = (await app.getState(config)).tasks.flatMap((t) => t.interrupts);
    assert.match((request?.value as ApprovalRequest).escalated ?? "", /R2 is above autopilot's ceiling/);
    assert.equal(approverCalled, false);
  });
});
