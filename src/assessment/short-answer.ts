import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getAgent, getSystemPrompt } from "../agents.js";
import { cosine, type Embedder } from "../guards/guards.js";
import { getStructuredModel, type Invokable } from "../models.js";
import type { GradedText, ItemOf } from "./items.js";

// Grading free text with a model, fenced in by code. The model only reports what it found; code
// decides what counts: unknown ids are dropped, an answer that tries to instruct the grader or a
// low-confidence grade is flagged for review (and not scored), and an item is only trusted after the
// grader reproduces its labelled calibration answers.

export const GraderOutputSchema = z.object({
  criteria_met: z.array(z.string()).describe("Ids of the rubric criteria the answer meets"),
  detectors_fired: z.array(z.string()).describe("Ids of the detectors whose wrong idea the answer expresses"),
  confidence: z.enum(["high", "low"]),
});
export type GraderOutput = z.infer<typeof GraderOutputSchema>;
export type GraderModel = Invokable<GraderOutput>;

export const createGraderModel = (): GraderModel => getStructuredModel(GraderOutputSchema, "grade_answer", getAgent("grader").model);

type ShortAnswer = ItemOf<"short_answer">;

/** Wording that addresses the grader instead of answering the question. */
const INSTRUCTION_LIKE = /\b(ignore|disregard)\b.{0,30}\b(instruction|rubric|prompt|above)|\b(full|maximum|all)\s+(marks|points|credit)\b|\bsystem prompt\b|\byou are (now )?(a|the) grader\b/i;

export const looksLikeInjection = (text: string) => INSTRUCTION_LIKE.test(text);

/** Longest answer the grader sees; anything longer is cut, so an answer can't bury the rubric. */
const MAX_ANSWER_CHARS = 1_000;

export async function gradeShortAnswer(
  item: ShortAnswer,
  text: string,
  model: GraderModel = createGraderModel(),
  embedder?: Embedder,
): Promise<GradedText> {
  const answer = text.slice(0, MAX_ANSWER_CHARS).replaceAll("</answer>", "");
  const output = await model.invoke([
    new SystemMessage(getSystemPrompt("grader")),
    new HumanMessage(
      `Question: ${item.prompt}\nReference answer: ${item.reference_answer}\n` +
        `Rubric criteria:\n${item.rubric.map((r) => `- ${r.id}: ${r.description}`).join("\n")}\n` +
        `Detectors:\n${item.detectors.map((d) => `- ${d.id}: ${d.description}`).join("\n") || "- none"}\n\n` +
        `<answer>\n${answer}\n</answer>`,
    ),
  ]);

  const criteria = output.criteria_met.filter((id) => item.rubric.some((r) => r.id === id));
  const detectors = output.detectors_fired.filter((id) => item.detectors.some((d) => d.id === id));
  const unknownIds = criteria.length !== output.criteria_met.length || detectors.length !== output.detectors_fired.length;

  let disagrees = false;
  if (embedder) {
    // A second, non-model opinion: the score of the most similar labelled calibration answer.
    const vectors = await embedder.embed([answer, ...item.calibration.map((c) => c.answer)]);
    const nearest = item.calibration
      .map((c, i) => ({ c, similarity: cosine(vectors[0]!, vectors[i + 1]!) }))
      .reduce((best, x) => (x.similarity > best.similarity ? x : best));
    const score = (ids: string[]) => item.rubric.filter((r) => ids.includes(r.id)).reduce((s, r) => s + r.points, 0);
    const total = score(item.rubric.map((r) => r.id));
    disagrees = Math.abs(score(criteria) - score(nearest.c.criteria)) / total > 0.5;
  }

  return {
    text,
    criteria,
    detectors,
    needs_review: output.confidence === "low" || unknownIds || looksLikeInjection(text) || disagrees,
  };
}

export interface CalibrationResult {
  passed: boolean;
  mismatches: { answer: string; expected: { criteria: string[]; detectors: string[] }; got: { criteria: string[]; detectors: string[] } }[];
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Runs the grader on every labelled calibration answer. An item is only scored once this passes. */
export async function calibrateGrader(item: ShortAnswer, model: GraderModel = createGraderModel()): Promise<CalibrationResult> {
  const mismatches: CalibrationResult["mismatches"] = [];
  for (const example of item.calibration) {
    const got = await gradeShortAnswer(item, example.answer, model);
    if (!same(got.criteria, example.criteria) || !same(got.detectors, example.detectors) || got.needs_review) {
      mismatches.push({ answer: example.answer, expected: { criteria: example.criteria, detectors: example.detectors }, got });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}
