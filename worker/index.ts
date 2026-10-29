import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { routeAgentRequest } from "agents";

// LangGraph finds the running graph (for interrupt() and config propagation) through async-local
// storage. Its non-Node builds don't set one up, so register the runtime's (nodejs_compat) once.
AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

export { CourseAgent } from "./course-agent.js";

/** WebSocket and RPC traffic for agents goes to their Durable Objects; everything else is the UI's static assets. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
