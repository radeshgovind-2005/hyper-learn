import type { BaseMessage } from "@langchain/core/messages";
import type { InteropZodType } from "@langchain/core/utils/types";
import { ChatOpenAI } from "@langchain/openai";

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

export const MODEL_TYPES = ["reasoning", "fast"] as const;
export type ModelType = (typeof MODEL_TYPES)[number];
type StructuredOutputMethod = "jsonSchema" | "functionCalling" | "jsonMode";

/** The only part of a model the nodes depend on — lets tests pass in fakes. */
export interface Invokable<T> {
  invoke(messages: BaseMessage[]): Promise<T>;
}

const LOCAL_DEFAULT_MODEL = "meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M";

const MODEL_PROFILES: Record<ModelType, { envVar: string; temperature: number }> = {
  // Curator + Reflection: a little creativity when proposing graph mutations.
  reasoning: { envVar: "REASONING_MODEL", temperature: 0.2 },
  // Learner Assistant: deterministic, reliable tool calls.
  fast: { envVar: "FAST_MODEL", temperature: 0 },
};

/** Reads a numeric env var, falling back to `fallback` when unset or invalid. */
function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const cache = new Map<ModelType, ChatOpenAI>();

export function getModel(type: ModelType): ChatOpenAI {
  const cached = cache.get(type);
  if (cached) return cached;

  const profile = MODEL_PROFILES[type];
  const model = new ChatOpenAI({
    model: process.env[profile.envVar] ?? LOCAL_DEFAULT_MODEL,
    temperature: profile.temperature,
    apiKey: process.env.MODEL_API_KEY ?? "not-needed-locally",
    // Fail a stuck call instead of hanging. LangChain otherwise retries up to 6 times,
    // which turns one timeout into an hour-long wait on a slow local model.
    timeout: numberFromEnv("MODEL_TIMEOUT_MS", 600_000),
    maxRetries: numberFromEnv("MODEL_MAX_RETRIES", 1),
    configuration: {
      baseURL: process.env.MODEL_BASE_URL ?? "http://localhost:9931/v1",
    },
  });

  cache.set(type, model);
  return model;
}

/** A model bound to a Zod schema; `invoke` resolves to the parsed object. */
export function getStructuredModel<T extends Record<string, unknown>>(
  schema: InteropZodType<T>,
  name: string,
  type: ModelType = "reasoning",
): Invokable<T> {
  const method = (process.env.STRUCTURED_OUTPUT_METHOD ?? "jsonSchema") as StructuredOutputMethod;
  return getModel(type).withStructuredOutput(schema, { name, method });
}
