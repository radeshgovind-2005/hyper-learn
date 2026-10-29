import type { BaseMessage } from "@langchain/core/messages";
import type { InteropZodType } from "@langchain/core/utils/types";
import { ChatOpenAI } from "@langchain/openai";

/**
 * Model factory.
 *
 * Every model talks to an OpenAI-compatible endpoint, so the same code runs against the local
 * llama.cpp / LM Studio server and Meta's API. Settings come from `configureModels()` (the Worker
 * passes its environment) or, by default, from environment variables (Node reads `.env`).
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

const TEMPERATURE: Record<ModelType, number> = {
  // Curator, Reflection, Author, Reviewer, Approver: a little creativity.
  reasoning: 0.2,
  // Learner Assistant and Grader: deterministic, reliable tool calls and grades.
  fast: 0,
};

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  models: Record<ModelType, string>;
  structuredOutputMethod: StructuredOutputMethod;
  /** Per-call timeout; a stuck call fails instead of hanging. */
  timeoutMs: number;
  maxRetries: number;
  /** A fetch to use instead of the global one (Node swaps in one without a 5-minute header limit). */
  fetch?: typeof globalThis.fetch;
  fetchOptions?: Record<string, unknown>;
}

/** String settings by environment-variable name, e.g. Node's process.env or a Worker's env bindings. */
export type ModelEnv = Readonly<Record<string, string | undefined>>;

const numberFrom = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Reads model settings from environment variables, with local-server defaults. */
export function modelConfigFromEnv(env: ModelEnv): ModelConfig {
  return {
    baseURL: env.MODEL_BASE_URL ?? "http://localhost:9931/v1",
    apiKey: env.MODEL_API_KEY ?? "not-needed-locally",
    models: {
      reasoning: env.REASONING_MODEL ?? LOCAL_DEFAULT_MODEL,
      fast: env.FAST_MODEL ?? LOCAL_DEFAULT_MODEL,
    },
    structuredOutputMethod: (env.STRUCTURED_OUTPUT_METHOD as StructuredOutputMethod | undefined) ?? "jsonSchema",
    timeoutMs: numberFrom(env.MODEL_TIMEOUT_MS, 600_000),
    // LangChain otherwise retries up to 6 times, which turns one timeout into an hour-long wait.
    maxRetries: numberFrom(env.MODEL_MAX_RETRIES, 1),
  };
}

let config: ModelConfig | undefined;
const cache = new Map<ModelType, ChatOpenAI>();

/** Sets (or adjusts) the model settings; models created before are discarded. */
export function configureModels(settings: Partial<ModelConfig> = {}) {
  config = { ...currentConfig(), ...settings };
  cache.clear();
}

export function currentConfig(): ModelConfig {
  config ??= modelConfigFromEnv(typeof process === "undefined" ? {} : process.env);
  return config;
}

export function getModel(type: ModelType): ChatOpenAI {
  const cached = cache.get(type);
  if (cached) return cached;

  const settings = currentConfig();
  const model = new ChatOpenAI({
    model: settings.models[type],
    temperature: TEMPERATURE[type],
    apiKey: settings.apiKey,
    timeout: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    configuration: {
      baseURL: settings.baseURL,
      ...(settings.fetch && { fetch: settings.fetch }),
      ...(settings.fetchOptions && { fetchOptions: settings.fetchOptions }),
    },
  });

  cache.set(type, model);
  return model;
}

/** Makes a schema-bound model. getStructuredModel is one; a per-course provider (with its owner's key) is another. */
export type StructuredFactory = <T extends Record<string, unknown>>(schema: InteropZodType<T>, name: string, type?: ModelType) => Invokable<T>;

/** A model bound to a Zod schema; `invoke` resolves to the parsed object. */
export function getStructuredModel<T extends Record<string, unknown>>(
  schema: InteropZodType<T>,
  name: string,
  type: ModelType = "reasoning",
): Invokable<T> {
  return getModel(type).withStructuredOutput(schema, { name, method: currentConfig().structuredOutputMethod });
}
