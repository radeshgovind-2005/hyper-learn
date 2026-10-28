import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { z } from "zod";
import prompts from "./config/prompts.json" with { type: "json" };

// ─── Domain schemas ────────────────────────────────────────────────

export const NodePerformanceSchema = z.object({
  node_id: z.string(),
  title: z.string(),
  attempts: z.number().int().nonnegative(),
  fail_rate: z.number().min(0).max(1).describe("Fraction of failed attempts, 0–1"),
});
export type NodePerformance = z.infer<typeof NodePerformanceSchema>;

export const MUTATION_ACTIONS = [
  "split_node",
  "merge_nodes",
  "add_prerequisite",
  "remove_prerequisite",
  "flag_for_review",
] as const;

/** Strict structured output of the Curator: exactly one graph mutation. */
export const MutationSchema = z.object({
  action: z.enum(MUTATION_ACTIONS).describe("The single graph mutation to apply"),
  node_id: z.string().describe("The node being mutated"),
  // Nullable rather than optional: strict JSON-schema mode requires every key to be present.
  target_node_id: z
    .string()
    .nullable()
    .describe("Second node for merge/prerequisite actions, otherwise null"),
  reason: z.string().describe("Evidence-based justification citing the performance data"),
});
export type Mutation = z.infer<typeof MutationSchema>;

/** Structured output of the Reflection node. */
export const ReflectionVerdictSchema = z.object({
  approved: z.boolean().describe("true if the mutation should be applied as-is"),
  critique: z.string().describe("Why it was approved, or what must change"),
});
export type ReflectionVerdict = z.infer<typeof ReflectionVerdictSchema>;

// ─── Routing types ─────────────────────────────────────────────────

export type InputType = "user_question" | "cron";
export type Route = "assistant" | "curator";

/** Total Curator proposals allowed before the reflection loop gives up. */
export const MAX_CURATOR_ATTEMPTS = 2;

// ─── Graph state ───────────────────────────────────────────────────

export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  input_type: Annotation<InputType>(),
  route: Annotation<Route | undefined>(),
  performance_data: Annotation<NodePerformance[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  proposed_mutation: Annotation<Mutation | undefined>(),
  reflection_verdict: Annotation<ReflectionVerdict | undefined>(),
  reflection_attempts: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
});

export type State = typeof GraphState.State;
export type StateUpdate = typeof GraphState.Update;

// ─── Prompts (loaded from src/config/prompts.json) ─────────────────

export type PromptName = keyof typeof prompts;

/** Returns a system prompt, replacing `{placeholder}` tokens with `vars`. */
export function getPrompt(name: PromptName, vars: Record<string, string> = {}): string {
  return prompts[name].replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}
