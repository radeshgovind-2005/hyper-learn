import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { z } from "zod";

// ─── Domain schemas ────────────────────────────────────────────────

export const MisconceptionSchema = z.object({
  points_to: z.string().describe("Lesson the wrong answers point to; the lesson's own id = a gap inside it"),
  share: z.number().min(0).max(1).describe("Fraction of the lesson's wrong answers"),
});
export type Misconception = z.infer<typeof MisconceptionSchema>;

export const NodePerformanceSchema = z.object({
  node_id: z.string(),
  title: z.string(),
  attempts: z.number().int().nonnegative().describe("Learners who took the lesson's quiz"),
  fail_rate: z.number().min(0).max(1).describe("Fraction of attempts that failed the quiz, 0–1"),
  fail_rate_ci: z.tuple([z.number(), z.number()]).describe("95% confidence interval for fail_rate"),
  low_sample: z.boolean().describe("Too few attempts for fail_rate to be reliable"),
  prerequisites: z.array(z.string()).describe("Node ids this node depends on"),
  misconceptions: z.array(MisconceptionSchema).describe("Where wrong answers point, largest share first"),
});
export type NodePerformance = z.infer<typeof NodePerformanceSchema>;

/** Performance data as the Curator and Reflection read it: a one-line legend, then compact JSON. */
export function formatPerformanceData(data: readonly NodePerformance[]): string {
  return (
    "Performance data, one entry per lesson. fail_rate_ci = 95% confidence interval; " +
    "low_sample = too few attempts to trust; misconceptions = where wrong answers point " +
    "(the lesson's own id = a gap inside that lesson).\n" +
    JSON.stringify(data)
  );
}

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
  approved: z.boolean().describe("true only if every check passed"),
  critique: z
    .string()
    .describe("One 'n NAME: PASS|FAIL — evidence' line per check, plus a 'FIX:' line if any failed"),
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
