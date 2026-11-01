import { z } from "zod";
import { Slug } from "../assessment/items.js";

// Interventions are content blocks that target one named misconception. They are templates whose
// content an agent fills as validated JSON, never generated code: the UI renders each template, and
// code checks every field before a release can include one (src/interventions/checks.ts).
// Every field is required (nullable where it may be empty), because the Author fills these through a
// strict JSON-schema structured output.

const text = (max: number) => z.string().min(1).max(max);

/** An option in a check or practice question. Feedback is shown after answering, right or wrong. */
const FeedbackOptionSchema = z.strictObject({
  text: text(200),
  correct: z.boolean(),
  misconception: Slug.nullable().describe("The misconception this wrong option expresses, or null"),
  feedback: text(300).describe("Shown after the learner picks this option"),
});

export const CheckQuestionSchema = z.strictObject({
  prompt: text(300),
  options: z.array(FeedbackOptionSchema).min(2).max(5),
});
export type CheckQuestion = z.infer<typeof CheckQuestionSchema>;

/** Names the belief, says why it is tempting, shows what really happens, then checks understanding. */
export const ContrastSchema = z.strictObject({
  template: z.literal("contrast"),
  targets: Slug,
  belief: text(200).describe("The misconception, stated as the learner would hold it"),
  why_it_seems_right: text(400).describe("Why the belief is tempting"),
  what_actually_happens: text(600).describe("What is actually true, concretely"),
  check: CheckQuestionSchema.describe("One question whose wrong option expresses the belief"),
});

/** Two or three practice questions with feedback on every option. Not scored. */
export const PracticeSchema = z.strictObject({
  template: z.literal("practice"),
  targets: Slug,
  questions: z.array(CheckQuestionSchema).min(2).max(3),
});

export const ROLES = ["user", "model", "harness", "tool"] as const;

/** A step-by-step animation, e.g. one turn of the agent loop: each frame shows the messages so far. */
export const StepThroughSchema = z.strictObject({
  template: z.literal("step_through"),
  targets: Slug,
  title: text(120),
  frames: z
    .array(
      z.strictObject({
        caption: text(240).describe("What happens in this step"),
        /** The message list at this step; `highlight` marks which entry just changed. */
        messages: z.array(z.strictObject({ role: z.enum(ROLES), text: text(240) })).min(1).max(8),
        highlight: z.number().int().min(0).nullable().describe("Index of the message that changed in this step, or null"),
      }),
    )
    .min(3)
    .max(8),
});

/** A parameter of an explorer's formula: a slider from min to max. Names are short identifiers the formula uses. */
const ParameterSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,11}$/, "a short name like N or p").describe("The name the formula uses, e.g. N"),
  label: text(60).describe("What it is, e.g. 'Number of cores'"),
  min: z.number(),
  max: z.number(),
  step: z.number().describe("Slider step, greater than 0, e.g. 1 for whole numbers"),
  value: z.number().describe("Where the slider starts"),
});

/**
 * A formula to play with, e.g. Amdahl's law: sliders for its parameters, a curve of the result over one
 * of them, and the value at the sliders. The formula is data in a tiny language (src/interventions/expr.ts),
 * evaluated by code, never run as code.
 */
export const ExplorerSchema = z.strictObject({
  template: z.literal("explorer"),
  targets: Slug,
  title: text(120),
  formula: text(200).describe("Arithmetic over the parameter names: + - * / ^, parentheses, min max log sqrt exp abs, e.g. 1 / ((1 - p) + p / N)"),
  result_label: text(60).describe("What the formula gives, e.g. 'Speedup'"),
  parameters: z.array(ParameterSchema).min(1).max(4),
  plot: z.string().describe("The parameter on the curve's horizontal axis"),
  takeaway: text(300).describe("What to notice when moving the sliders"),
});

/** Two cases side by side, one at a time behind a toggle, and the line that tells them apart. */
export const CompareSchema = z.strictObject({
  template: z.literal("compare"),
  targets: Slug,
  title: text(120),
  cases: z
    .array(
      z.strictObject({
        label: text(60),
        points: z.array(text(200)).min(1).max(5),
        figure: z.strictObject({ label: text(60), value: z.number(), unit: z.string().max(20) }).nullable().describe("One number for the bar under each case, e.g. latency 100 ns, or null"),
      }),
    )
    .length(2),
  takeaway: text(300),
});

export const InterventionSchema = z.discriminatedUnion("template", [ContrastSchema, PracticeSchema, StepThroughSchema, ExplorerSchema, CompareSchema]);
export type Intervention = z.infer<typeof InterventionSchema>;
export type Template = Intervention["template"];
export const TEMPLATES = ["contrast", "practice", "step_through", "explorer", "compare"] as const satisfies readonly Template[];

/** Every question an intervention asks (to check leakage against the quiz and tags against the catalog). */
export function interventionQuestions(intervention: Intervention): CheckQuestion[] {
  switch (intervention.template) {
    case "contrast":
      return [intervention.check];
    case "practice":
      return intervention.questions;
    case "step_through":
    case "explorer":
    case "compare":
      return [];
  }
}

/** Every piece of text an intervention shows, for sanitizing, safety checks and leakage checks. */
export function interventionTexts(intervention: Intervention): string[] {
  const questions = interventionQuestions(intervention).flatMap((q) => [q.prompt, ...q.options.flatMap((o) => [o.text, o.feedback])]);
  switch (intervention.template) {
    case "contrast":
      return [intervention.belief, intervention.why_it_seems_right, intervention.what_actually_happens, ...questions];
    case "practice":
      return questions;
    case "step_through":
      return [intervention.title, ...intervention.frames.flatMap((f) => [f.caption, ...f.messages.map((m) => m.text)])];
    case "explorer":
      return [intervention.title, intervention.result_label, intervention.takeaway, ...intervention.parameters.map((p) => p.label)];
    case "compare":
      return [intervention.title, intervention.takeaway, ...intervention.cases.flatMap((c) => [c.label, ...c.points, ...(c.figure ? [c.figure.label, c.figure.unit] : [])])];
  }
}

/**
 * Which templates fit a misconception, decided in code from how it is held: a confidently held belief
 * needs refuting (a contrast or a step-through that shows what really happens); an unsure one is a
 * knowledge gap, which practice fills.
 */
export function allowedTemplates(confident: number): Template[] {
  return confident >= 0.5 ? ["contrast", "step_through"] : ["practice"];
}
