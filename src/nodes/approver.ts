import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getAgent, getSystemPrompt } from "../agents.js";
import { getStructuredModel, type Invokable } from "../models.js";
import type { Approver } from "./release.js";

export const ApproverVerdictSchema = z.object({
  approved: z.boolean().describe("true to send the release to a trial"),
  reason: z.string().describe("One sentence"),
});
export type ApproverVerdict = z.infer<typeof ApproverVerdictSchema>;
export type ApproverModel = Invokable<ApproverVerdict>;

export const createApproverModel = (): ApproverModel =>
  getStructuredModel(ApproverVerdictSchema, "approve_release", getAgent("approver").model);

/**
 * Autopilot's approver: an agent that decides on a course owner's behalf. It is only ever asked about
 * releases code allows autopilot to approve (see AUTOPILOT_MAY_APPROVE), and an approved release
 * still has to survive its trial.
 */
export function createApprover(model: ApproverModel = createApproverModel()): Approver {
  return async (request) => {
    const verdict = await model.invoke([
      new SystemMessage(getSystemPrompt("approver")),
      new HumanMessage(
        `Release ${request.version} (from ${request.parent}), risk ${request.tier}, ${request.bump} bump.\n` +
          `Changes:\n${request.changes.map((c) => `- ${c}`).join("\n")}\nRationale: ${request.rationale}`,
      ),
    ]);
    return { approved: verdict.approved, note: verdict.reason };
  };
}
