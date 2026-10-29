import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

// LangSmith tracing. LangChain and LangGraph trace every node and model call on their own once these
// are set (in `.env` for Node, as Worker vars and secrets in the Worker):
//
//   LANGSMITH_TRACING=true
//   LANGSMITH_API_KEY=<key>
//   LANGSMITH_PROJECT=hyperlearn          (optional; default "default")
//   LANGSMITH_ENDPOINT=<url>              (optional; e.g. the EU region)
//
// Off by default: traces include prompts and learner data, and are sent to LangSmith.
// This module only labels runs so they can be found, and flushes pending traces before a run ends.

export const LANGSMITH_SETTINGS = ["LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT"] as const;

export function tracingEnabled(env: Readonly<Record<string, string | undefined>> = typeof process === "undefined" ? {} : process.env): boolean {
  return env.LANGSMITH_TRACING === "true" && Boolean(env.LANGSMITH_API_KEY);
}

/** Name, tags and metadata for a run's root trace: what LangSmith shows and filters by. */
export function traceConfig(run: {
  name: string;
  thread_id?: string;
  scenario?: string;
  mode?: string;
  agents?: boolean;
  release?: string;
}) {
  const { name, ...metadata } = run;
  return {
    runName: name,
    tags: [
      "hyperlearn",
      ...(run.scenario ? [`scenario:${run.scenario}`] : []),
      ...(run.mode ? [`mode:${run.mode}`] : []),
      ...(run.agents === undefined ? [] : [run.agents ? "agents:model" : "agents:reference"]),
    ],
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined)),
  };
}

/**
 * Waits until every pending trace has been sent. Call before a run is reported done: a Worker may be
 * suspended, and a CLI may exit, before background sends finish. A no-op when tracing is off.
 */
export async function flushTraces(): Promise<void> {
  try {
    await awaitAllCallbacks();
  } catch (error) {
    console.warn("LangSmith: some traces could not be sent:", error);
  }
}
