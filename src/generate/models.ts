import { getRetryable } from "@langchain/core/errors";
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
 * Waits before each retry of a failed call. A build makes ~100 calls, so one outage or rate limit
 * shouldn't throw it away: the waits cover about 40 seconds of trouble before the build gives up.
 */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

/**
 * Whether retrying can help. LangChain marks some errors itself (a prompt over the context window, an
 * exhausted quota); otherwise: no HTTP status (network error, timeout, unparseable output) or a status
 * that clears on its own. Other 4xx (bad key, bad request) fail the same way every time.
 */
export function isRetryable(error: unknown): boolean {
  const marked = getRetryable(error);
  if (marked !== undefined) return marked;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status === 408 || status === 409 || status === 429 || status >= 500;
}

export interface RetryOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every model call of a build goes through here: it enforces the per-call input limit and the total
 * number of calls, retries a failed call after a growing wait, and counts calls for the report.
 */
export class ModelCalls {
  count = 0;
  private readonly delays: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly maxChars: number,
    readonly maxCalls: number,
    retry: RetryOptions = {},
  ) {
    this.delays = retry.delays ?? RETRY_DELAYS_MS;
    this.sleep = retry.sleep ?? sleep;
  }

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
    for (let attempt = 0; ; attempt++) {
      if (this.count >= this.maxCalls) throw new CallBudgetExceeded(`Stopped after ${this.count} model calls (the limit for one build)`);
      this.count++;
      try {
        return await model.invoke(messages);
      } catch (error) {
        const delay = this.delays[attempt];
        if (delay === undefined || !isRetryable(error)) throw error instanceof Error ? error : new Error(String(error));
        await this.sleep(delay);
      }
    }
  }
}
