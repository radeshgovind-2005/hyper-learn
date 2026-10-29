import { END, interrupt } from "@langchain/langgraph";
import { decideTrial } from "../measure/decide.js";
import type { Measurer } from "../measure/measure.js";
import { describeChange, type RiskTier } from "../releases/changes.js";
import { changesFor } from "../releases/from-mutation.js";
import { type Approval, planRelease, promote, type Release, type ReleaseStore, revert } from "../releases/release.js";
import type { State, StateUpdate } from "../state.js";
import { logNode } from "../utils/logger.js";

// The release harness every approved proposal goes through:
//   plan_release → approval → (trial) → measure → decide
// Guarantees are code: the candidate is built on a copy and re-validated, the risk tier and version are
// computed, autopilot can't approve past its ceiling, and measurement decides keep or revert.

/** Approval modes. HITL interrupts on every change; autopilot decides alone below its ceiling. */
export type ApprovalMode = "hitl" | "autopilot";

/** Tiers autopilot may approve without a human. R2 (whole lessons, the quiz) always interrupts. */
export const AUTOPILOT_MAY_APPROVE: ReadonlySet<RiskTier> = new Set(["R0", "R1"]);

/** What a human sees when the graph pauses for approval. */
export interface ApprovalRequest {
  kind: "approve_release";
  version: string;
  parent: string;
  tier: RiskTier;
  bump: Release["bump"];
  changes: string[];
  rationale: string;
  /** Why a human is being asked even in autopilot, if so. */
  escalated?: string;
}

/** The value a human resumes the graph with: `new Command({ resume: { approved, note } })`. */
export interface ApprovalResponse {
  approved: boolean;
  note?: string;
}

/** Decides on behalf of a human in autopilot mode, within the ceiling. */
export type Approver = (request: ApprovalRequest, candidate: Release) => Promise<ApprovalResponse>;

export interface Harness {
  store: ReleaseStore;
  measurer: Measurer;
  mode: ApprovalMode;
  /** Used in autopilot mode. */
  approver?: Approver;
}

export function createPlanReleaseNode({ store }: Harness) {
  return async function planReleaseNode(state: State): Promise<StateUpdate> {
    const proposal = state.proposed_mutation;
    if (!proposal) throw new Error("plan_release reached without a proposal");

    const mapped = changesFor(proposal);
    if ("reason" in mapped) {
      logNode("release", `Nothing to release: ${mapped.reason}`);
      return { release_problems: [mapped.reason], live_version: store.live().version };
    }

    const plan = planRelease(store, mapped.changes, proposal.reason);
    if (!plan.ok) {
      logNode("release", "❌ Candidate breaks the course, not released:", plan.problems.join("\n"));
      return { release_problems: plan.problems, live_version: store.live().version };
    }
    const { candidate } = plan;
    logNode(
      "release",
      `Candidate ${candidate.version} (from ${candidate.parent}, ${candidate.bump} bump, risk ${candidate.tier}): ` +
        candidate.changes.map(describeChange).join("; "),
    );
    return { candidate, release_problems: undefined };
  };
}

export function createApprovalNode({ store, mode, approver }: Harness) {
  return async function approvalNode(state: State): Promise<StateUpdate> {
    const candidate = state.candidate;
    if (!candidate) throw new Error("approval reached without a candidate");

    const request: ApprovalRequest = {
      kind: "approve_release",
      version: candidate.version,
      parent: candidate.parent ?? "",
      tier: candidate.tier,
      bump: candidate.bump,
      changes: candidate.changes.map(describeChange),
      rationale: candidate.rationale ?? "",
    };

    let approval: Approval;
    if (mode === "autopilot" && AUTOPILOT_MAY_APPROVE.has(candidate.tier)) {
      if (!approver) throw new Error("autopilot mode needs an approver");
      const response = await approver(request, candidate);
      approval = { ...response, by: "autopilot" };
    } else {
      if (mode === "autopilot") request.escalated = `risk ${candidate.tier} is above autopilot's ceiling`;
      // Pauses the graph until a human answers. Nothing before this line has side effects, because the
      // node runs again from the top when the graph resumes.
      const response = interrupt<ApprovalRequest, ApprovalResponse>(request);
      approval = { approved: response.approved, by: "human", ...(response.note && { note: response.note }) };
    }

    store.add({ ...candidate, status: approval.approved ? "trial" : "rejected", approval });
    logNode("approval", `${approval.approved ? "✅ Approved" : "❌ Rejected"} by ${approval.by}${approval.note ? `: ${approval.note}` : ""}`);
    return { approval, live_version: store.live().version };
  };
}

export const routeFromApproval = (state: State): "measure" | typeof END => (state.approval?.approved ? "measure" : END);

export function createMeasureNode({ store, measurer }: Harness) {
  return async function measureNode(state: State): Promise<StateUpdate> {
    const version = state.candidate?.version;
    const trial = version && store.get(version);
    if (!trial) throw new Error("measure reached without a trial");

    logNode("measure", `Trial ${trial.version} vs live ${store.live().version}...`);
    const measurement = await measurer.measure(store.live(), trial);
    store.update(trial.version, { measurement });
    const { primary } = measurement;
    logNode(
      "measure",
      `${primary.lesson} ${primary.metric}: ${primary.control.rate} → ${primary.treatment.rate} ` +
        `(Δ ${primary.diff}, 95% CI ${primary.diff_ci.join("…")}, ${measurement.source})`,
    );
    return { measurement };
  };
}

export function createDecideNode({ store }: Harness) {
  return async function decideNode(state: State): Promise<StateUpdate> {
    const { candidate, measurement } = state;
    if (!candidate || !measurement) throw new Error("decide reached without a measured trial");

    const decision = decideTrial(measurement);
    store.update(candidate.version, { decision });
    if (decision.verdict === "keep") {
      const released = promote(store, candidate.version);
      logNode("decide", `✅ KEEP — released as ${released.version}`, decision.reasons.join("\n"));
    } else {
      revert(store, candidate.version);
      logNode("decide", `↩️  REVERT — ${store.live().version} stays live`, decision.reasons.join("\n"));
    }
    return { trial_decision: decision, live_version: store.live().version };
  };
}
