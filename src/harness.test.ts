import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { liveInterventions } from "./course/compile.js";
import { referenceCurator } from "./eval/reference.js";
import { buildGraph } from "./graph.js";
import { compare, type Measurement, outcome } from "./measure/decide.js";
import { EXEMPLARS } from "./interventions/exemplars.js";
import type { Intervention } from "./interventions/templates.js";
import type { Measurer } from "./measure/measure.js";
import type { Embedder, Guard } from "./guards/guards.js";
import { createReviewContentNode } from "./nodes/author.js";
import { createApprover } from "./nodes/approver.js";
import { type ApprovalRequest, createApprovalNode, type Harness } from "./nodes/release.js";
import { MemoryReleaseStore, type Release } from "./releases/release.js";
import { scenarioPerformance, scenarioSnapshot } from "./simulation/index.js";
import { getScenario } from "./simulation/scenarios.js";
import { type Draft, GraphState, MAX_AUTHOR_ATTEMPTS, type Mutation, type ReflectionVerdict, type State } from "./state.js";

const textOf = (message: BaseMessage | undefined) =>
  typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);

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

describe("authoring (add_intervention)", () => {
  const dominant = getScenario("dominant-misconception");
  const dominantData = scenarioPerformance(dominant);
  const intervene = referenceCurator(dominantData); // add_intervention(agent-loop : model-executes-actions)
  const contrast = EXEMPLARS.find((e) => e.template === "contrast")!;
  const practice = EXEMPLARS.find((e) => e.template === "practice")!;
  const good: Draft = { section_id: "agent-loop/the-harness-does-the-acting", intervention: contrast };

  function run(
    drafts: Draft[],
    reviews: ReflectionVerdict[] = drafts.map(() => ({ approved: true, critique: "ok" })),
    services: Pick<Harness, "guard" | "embedder"> = {},
  ) {
    const store = new MemoryReleaseStore(scenarioSnapshot(dominant));
    const authorCalls: BaseMessage[][] = [];
    const reviewerCalls: BaseMessage[][] = [];
    const app = buildGraph(
      {
        curator: { invoke: async () => intervene },
        reflection: { invoke: async () => ({ approved: true, critique: "ok" }) },
        author: {
          invoke: async (messages) => {
            authorCalls.push(messages);
            const draft = drafts[authorCalls.length - 1];
            if (!draft) throw new Error("unexpected author call");
            return draft;
          },
        },
        reviewer: {
          invoke: async (messages) => {
            reviewerCalls.push(messages);
            return reviews[reviewerCalls.length - 1]!;
          },
        },
      },
      { harness: { store, measurer: fakeMeasurer(true).measurer, mode: "autopilot", approver: async () => ({ approved: true }), ...services } },
    );
    return { store, authorCalls, reviewerCalls, result: app.invoke({ input_type: "cron", performance_data: dominantData }, { recursionLimit: 30 }) };
  }

  it("releases an approved draft as a minor version", async () => {
    const { store, authorCalls, result: running } = run([good]);
    const result = await running;
    assert.equal(authorCalls.length, 1);
    assert.match(textOf(authorCalls[0]!.at(-1)), /Do NOT reuse/);
    assert.equal(result.live_version, "1.1.0");
    assert.equal(liveInterventions(store.live().snapshot)[0]?.block_id, "agent-loop/the-harness-does-the-acting/i1");
  });

  it("rejects a template code doesn't allow without asking the reviewer, and retries with the problems", async () => {
    const r = run([{ section_id: good.section_id, intervention: { ...practice, targets: "model-executes-actions" } as Intervention }, good]);
    const state = await r.result;
    assert.equal(r.authorCalls.length, 2);
    assert.equal(r.reviewerCalls.length, 1, "only the valid draft reaches the reviewer model");
    assert.match(textOf(r.authorCalls[1]!.at(-1)), /CODE CHECK: FAIL — template "practice" isn't allowed here/);
    assert.equal(state.live_version, "1.1.0");
  });

  it(`gives up after ${MAX_AUTHOR_ATTEMPTS} rejected drafts and releases nothing`, async () => {
    const reject: ReflectionVerdict = { approved: false, critique: "1 TARGET: FAIL — vague" };
    const r = run(
      Array.from({ length: MAX_AUTHOR_ATTEMPTS }, () => good),
      Array.from({ length: MAX_AUTHOR_ATTEMPTS }, () => reject),
    );
    const state = await r.result;
    assert.equal(r.authorCalls.length, MAX_AUTHOR_ATTEMPTS);
    assert.equal(state.candidate, undefined);
    assert.equal(r.store.all().length, 1);
  });
});

describe("authoring with model services", () => {
  const dominant = getScenario("dominant-misconception");
  const contrast = EXEMPLARS.find((e) => e.template === "contrast")!;
  const good: Draft = { section_id: "agent-loop/the-harness-does-the-acting", intervention: contrast };

  async function review(services: Pick<Harness, "guard" | "embedder">) {
    const store = new MemoryReleaseStore(scenarioSnapshot(dominant));
    let reviewerCalled = false;
    const node = createReviewContentNode({ store, measurer: fakeMeasurer(true).measurer, mode: "hitl", ...services }, {
      invoke: async () => {
        reviewerCalled = true;
        return { approved: true, critique: "ok" };
      },
    });
    const data = scenarioPerformance(dominant);
    const update = await node({ ...({} as State), proposed_mutation: referenceCurator(data), performance_data: data, draft: good });
    return { verdict: update.content_verdict!, reviewerCalled };
  }

  it("rejects a question that paraphrases a quiz question, which word overlap misses", async () => {
    // A fake embedding space where the draft's check question and quiz question agent-loop-q2 mean the same.
    const embedder: Embedder = {
      embed: async (texts) => texts.map((t) => (/notes\.txt|Who actually carries out/.test(t) ? [1, 0] : [0, 1])),
    };
    const { verdict, reviewerCalled } = await review({ embedder });
    assert.equal(verdict.approved, false);
    assert.match(verdict.critique, /paraphrases quiz question "agent-loop-q2"/);
    assert.equal(reviewerCalled, false);
  });

  it("rejects content the safety model flags", async () => {
    const guard: Guard = { check: async () => ({ safe: false, categories: ["S10"] }) };
    const { verdict, reviewerCalled } = await review({ guard });
    assert.match(verdict.critique, /unsafe content \(S10\)/);
    assert.equal(reviewerCalled, false);
  });

  it("goes on to the reviewer when every service check passes", async () => {
    const { verdict, reviewerCalled } = await review({
      guard: { check: async () => ({ safe: true, categories: [] }) },
      embedder: { embed: async (texts) => texts.map((_, i) => [i, 1]) },
    });
    assert.equal(verdict.approved, true);
    assert.equal(reviewerCalled, true);
  });
});

describe("Approver agent", () => {
  it("passes the agent's decision and reason through", async () => {
    const calls: BaseMessage[][] = [];
    const approver = createApprover({
      invoke: async (messages) => {
        calls.push(messages);
        return { approved: false, reason: "The rationale doesn't support it." };
      },
    });
    const response = await approver(
      { kind: "approve_release", version: "1.1.0-trial.1", parent: "1.0.0", tier: "R0", bump: "minor", changes: ["add x"], rationale: "why" },
      {} as Release,
    );
    assert.deepEqual(response, { approved: false, note: "The rationale doesn't support it." });
    assert.match(textOf(calls[0]!.at(-1)), /Release 1.1.0-trial.1 \(from 1.0.0\), risk R0/);
  });
});
