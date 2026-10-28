import { ChatOpenAI } from "@langchain/openai";
import type { InteropZodType } from "@langchain/core/utils/types";

/**
 * Model factory.
 *
 * Every model talks to an OpenAI-compatible endpoint configured via env vars,
 * so the same code runs against the local llama.cpp / LM Studio server and Meta's API.
 *
 * ▶ Switching to the real Meta Model API (Muse Spark):
 *   1. Set MODEL_BASE_URL to Meta's OpenAI-compatible base URL.
 *   2. Set MODEL_API_KEY to your Meta API key.
 *   3. Set REASONING_MODEL / FAST_MODEL to `muse-spark-1.3` (or another Muse model).
 *   No code changes are required.
 */

export type ModelType = "reasoning" | "fast";
type StructuredOutputMethod = "jsonSchema" | "functionCalling" | "jsonMode";

const LOCAL_DEFAULT_MODEL = "meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M";

const MODEL_PROFILES: Record<ModelType, { envVar: string; temperature: number }> = {
  // Curator + Reflection: a little creativity when proposing graph mutations.
  reasoning: { envVar: "REASONING_MODEL", temperature: 0.2 },
  // Learner Assistant: deterministic, reliable tool calls.
  fast: { envVar: "FAST_MODEL", temperature: 0 },
};

const cache = new Map<ModelType, ChatOpenAI>();

export function getModel(type: ModelType): ChatOpenAI {
  const cached = cache.get(type);
  if (cached) return cached;

  const profile = MODEL_PROFILES[type];
  const model = new ChatOpenAI({
    model: process.env[profile.envVar] ?? LOCAL_DEFAULT_MODEL,
    temperature: profile.temperature,
    apiKey: process.env.MODEL_API_KEY ?? "not-needed-locally",
    configuration: {
      baseURL: process.env.MODEL_BASE_URL ?? "http://localhost:9931/v1",
    },
  });

  cache.set(type, model);
  return model;
}

/** A reasoning model bound to a Zod schema; `invoke` resolves to the parsed object. */
export function getStructuredModel<T extends Record<string, unknown>>(
  schema: InteropZodType<T>,
  name: string,
) {
  const method = (process.env.STRUCTURED_OUTPUT_METHOD ?? "jsonSchema") as StructuredOutputMethod;
  return getModel("reasoning").withStructuredOutput(schema, { name, method });
}
