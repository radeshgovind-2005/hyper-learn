import { describeMutation } from "../cli/format.js";
import { describeChange, describeIntervention } from "../releases/changes.js";
import type { StateUpdate } from "../state.js";

// Turns graph node updates into the steps the UI's agent panel shows.

export type StepStatus = "ok" | "rejected" | "info" | "waiting";

export interface RunStep {
  node: string;
  /** Who did it: an agent (a model, or its stand-in in a reference run) or code. */
  actor: "agent" | "code" | "human";
  title: string;
  detail?: string;
  status: StepStatus;
  at: string;
}

const NODE_ACTORS: Record<string, RunStep["actor"]> = {
  supervisor: "code",
  curator: "agent",
  reflection: "agent",
  author: "agent",
  review_content: "agent",
  plan_release: "code",
  approve: "human",
  measure: "code",
  decide: "code",
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** One step per node update, or none for nodes the panel doesn't show. */
export function stepFor(node: string, update: StateUpdate, at: string): RunStep | undefined {
  const step = (title: string, status: StepStatus = "ok", detail?: string, actor = NODE_ACTORS[node] ?? "code"): RunStep => ({
    node,
    actor,
    title,
    status,
    at,
    ...(detail && { detail }),
  });
  switch (node) {
    case "curator":
      return update.proposed_mutation ? step(`Proposed ${describeMutation(update.proposed_mutation)}`, "ok", update.proposed_mutation.reason) : undefined;
    case "reflection": {
      const verdict = update.reflection_verdict;
      if (!verdict) return undefined;
      const byCode = verdict.critique.startsWith("CODE CHECK");
      return step(verdict.approved ? "Proposal approved" : `Proposal rejected${byCode ? " by code checks" : ""}`, verdict.approved ? "ok" : "rejected", verdict.critique, byCode ? "code" : "agent");
    }
    case "author":
      return update.draft
        ? step(`Drafted a ${describeIntervention(update.draft.intervention)}`, "ok", `Attached to ${update.draft.section_id}`)
        : undefined;
    case "review_content": {
      const verdict = update.content_verdict;
      if (!verdict) return undefined;
      const byCode = verdict.critique.startsWith("CODE CHECK");
      return step(verdict.approved ? "Draft approved" : `Draft rejected${byCode ? " by code checks" : ""}`, verdict.approved ? "ok" : "rejected", verdict.critique, byCode ? "code" : "agent");
    }
    case "plan_release":
      if (update.candidate) {
        const c = update.candidate;
        return step(`Candidate ${c.version}: risk ${c.tier}, ${c.bump} bump`, "ok", c.changes.map(describeChange).join("\n"));
      }
      return update.release_problems ? step("Nothing to release", "info", update.release_problems.join("\n")) : undefined;
    case "approve":
      return update.approval
        ? step(
            `${update.approval.approved ? "Approved" : "Rejected"} by ${update.approval.by}`,
            update.approval.approved ? "ok" : "rejected",
            update.approval.note,
            update.approval.by === "human" ? "human" : "agent",
          )
        : undefined;
    case "measure": {
      const pending = update.trial_pending;
      if (pending) {
        return step(
          `Trial running on real learners: ${pending.control}/${pending.needed} and ${pending.treatment}/${pending.needed}`,
          "waiting",
          `Half of learners get the new release. It's measured on ${pending.lesson} once both groups reach ${pending.needed} learners.`,
        );
      }
      const m = update.measurement;
      if (!m) return undefined;
      const p = m.primary;
      const metric = p.metric === "fail_rate" ? "fail rate" : `"${p.misconception}" persisting`;
      return step(
        `Trial: ${p.lesson} ${metric} ${pct(p.control.rate)} → ${pct(p.treatment.rate)}`,
        "info",
        `Δ ${pct(p.diff)} (95% CI ${pct(p.diff_ci[0])} to ${pct(p.diff_ci[1])}), ${p.control.attempts}/${p.treatment.attempts} learners, ${m.source}`,
      );
    }
    case "decide": {
      const d = update.trial_decision;
      if (!d) return undefined;
      return step(d.verdict === "keep" ? `Kept: ${update.live_version} is live` : `Reverted: ${update.live_version} stays live`, d.verdict === "keep" ? "ok" : "rejected", d.reasons.join("\n"));
    }
    default:
      return undefined;
  }
}
