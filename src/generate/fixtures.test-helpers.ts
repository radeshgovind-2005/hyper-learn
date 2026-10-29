import type { BaseMessage } from "@langchain/core/messages";
import type { Source } from "../course/sources.js";
import type { Invokable } from "../models.js";
import { cannedBuilderModels } from "./canned.js";
import type { BuilderModels } from "./models.js";
import type { BuildInput } from "./types.js";

// Made-up sources and model wrappers shared by the generation tests. "Bramble clocks" don't exist.

export const NOTES: Source = {
  id: "s1",
  name: "bramble-notes.md",
  pages: [
    "A bramble clock measures time by the growth of a trained bramble stem along a marked trellis. The keeper reads the hour from the notch the tip has reached. Growth is steady only when the soil stays damp, so keepers water the root bed at dawn and dusk. A dry bed slows the stem and makes the clock run late.",
    "Calibration sets the notches so that one notch equals one hour of growth. The keeper marks the tip at noon on two clear days and divides the distance by twenty-four. Cold nights shorten the daily growth, so winter trellises use wider spacing between notches. A clock calibrated in summer runs fast in winter if the notches are not moved.",
    "Pruning keeps the stem on its track. Side shoots steal growth from the main tip, so the keeper cuts them every third day. Cutting the main tip by mistake stops the clock until a new tip forms, which takes about a week. Old stems are replaced in spring, when growth is fastest and recalibration is quickest.",
  ],
};

export const EXAM: Source = {
  id: "s2",
  name: "winter-exam.txt",
  pages: [
    "Question 1. Describe how a keeper would determine the spacing of notches on a trellis for a winter clock.\nQuestion 2. A clock has started running late during a dry week; explain the cause and the remedy. (10 marks)",
  ],
};

export const INPUT: BuildInput = {
  course_id: "bramble-clocks",
  title: "Bramble Clocks",
  goal: "Keep a bramble clock accurate through the year.",
  sources: [NOTES, EXAM],
};

const userText = (messages: BaseMessage[]) => {
  const last = messages.at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

export interface Spy<T> extends Invokable<T> {
  /** Every user message received, in call order. */
  prompts: string[];
  /** Total characters per call, system prompt included. */
  sizes: number[];
}

/** Wraps a model: records each call and lets `override` replace the answer (return undefined to keep it). */
export function spy<T>(model: Invokable<T>, override?: (prompt: string, answer: T, call: number) => T | undefined): Spy<T> {
  const prompts: string[] = [];
  const sizes: number[] = [];
  return {
    prompts,
    sizes,
    async invoke(messages) {
      const prompt = userText(messages);
      prompts.push(prompt);
      sizes.push(messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0));
      const answer = await model.invoke(messages);
      return override?.(prompt, structuredClone(answer), prompts.length) ?? answer;
    },
  };
}

export type SpiedModels = { [K in keyof BuilderModels]: Spy<BuilderModels[K] extends Invokable<infer T> ? T : never> };

type Overrides = { [K in keyof BuilderModels]?: (prompt: string, answer: SpiedModels[K] extends Spy<infer T> ? T : never, call: number) => (SpiedModels[K] extends Spy<infer T> ? T : never) | undefined };

/** Canned models, each wrapped in a spy, with optional per-agent overrides. */
export function spiedModels(overrides: Overrides = {}): SpiedModels {
  const canned = cannedBuilderModels();
  return {
    classifier: spy(canned.classifier, overrides.classifier),
    digester: spy(canned.digester, overrides.digester),
    planner: spy(canned.planner, overrides.planner),
    writer: spy(canned.writer, overrides.writer),
    examiner: spy(canned.examiner, overrides.examiner),
    fact_checker: spy(canned.fact_checker, overrides.fact_checker),
  };
}

export const totalCalls = (models: SpiedModels) => Object.values(models).reduce((n, m: Spy<unknown>) => n + m.prompts.length, 0);
