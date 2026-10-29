import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { type AgentName, getAgent, getSystemPrompt } from "../agents.js";
import type { Invokable, StructuredFactory } from "../models.js";
import {
  type AssessmentDraft,
  AssessmentDraftSchema,
  type Classification,
  ClassificationSchema,
  type DigestDraft,
  DigestSchema,
  type GroundingVerdict,
  GroundingVerdictSchema,
  type PlanDraft,
  PlanDraftSchema,
  type SectionDraft,
  SectionDraftSchema,
} from "./schemas.js";

/** One model per generation agent, injected so tests run on scripted fakes. */
export interface BuilderModels {
  classifier: Invokable<Classification>;
  digester: Invokable<DigestDraft>;
  planner: Invokable<PlanDraft>;
  writer: Invokable<SectionDraft>;
  examiner: Invokable<AssessmentDraft>;
  fact_checker: Invokable<GroundingVerdict>;
}

/** The generation models on a structured-output factory (the default one, or a course owner's provider). */
export function createBuilderModels(structured: StructuredFactory): BuilderModels {
  return {
    classifier: structured(ClassificationSchema, "classify_source", getAgent("classifier").model),
    digester: structured(DigestSchema, "digest_pages", getAgent("digester").model),
    planner: structured(PlanDraftSchema, "plan_course", getAgent("planner").model),
    writer: structured(SectionDraftSchema, "write_section", getAgent("writer").model),
    examiner: structured(AssessmentDraftSchema, "write_assessment", getAgent("examiner").model),
    fact_checker: structured(GroundingVerdictSchema, "check_grounding", getAgent("fact_checker").model),
  };
}

/** The build ran out of its model-call allowance. Ends the build; other call failures are retried. */
export class CallBudgetExceeded extends Error {}

/**
 * Every model call of a build goes through here: it enforces the per-call input limit and the total
 * number of calls, retries a failed call once, and counts calls for the report.
 */
export class ModelCalls {
  count = 0;

  constructor(
    readonly maxChars: number,
    readonly maxCalls: number,
  ) {}

  /** Characters left for the user message of `agent`, after its system prompt. */
  room(agent: AgentName): number {
    return this.maxChars - getSystemPrompt(agent).length;
  }

  async invoke<T>(model: Invokable<T>, agent: AgentName, user: string): Promise<T> {
    const system = getSystemPrompt(agent);
    if (system.length + user.length > this.maxChars) {
      // Prompts are fitted before they get here, so this is a bug or a maxChars too small for the fixed parts.
      throw new Error(`The ${agent} prompt is ${system.length + user.length} characters, over the limit of ${this.maxChars}`);
    }
    const messages = [new SystemMessage(system), new HumanMessage(user)];
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.count >= this.maxCalls) throw new CallBudgetExceeded(`Stopped after ${this.count} model calls (the limit for one build)`);
      this.count++;
      try {
        return await model.invoke(messages);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
