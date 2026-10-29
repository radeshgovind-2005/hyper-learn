import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { routeAgentRequest } from "agents";
import { type Identity, roleFrom, verifySessionToken, withIdentity } from "../src/auth/identity.js";

// LangGraph finds the running graph (for interrupt() and config propagation) through async-local
// storage. Its non-Node builds don't set one up, so register the runtime's (nodejs_compat) once.
AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

export { CourseAgent } from "./course-agent.js";

interface AuthEnv {
  /** The Clerk instance's JWT public key (PEM): a secret, for networkless token verification. */
  CLERK_JWT_KEY?: string;
  /** Comma-separated origins allowed to have issued tokens (their `azp` claim). */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** Local testing only: "true" lets localhost requests name a user with ?devUser=&devRole=. Never set in production. */
  AUTH_DEV_BYPASS?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Every request to an agent must come from a signed-in person. The browser sends its Clerk session
 * token as ?token= (browsers can't set WebSocket headers); it's verified here, removed from the URL, and
 * replaced by identity headers the Durable Object trusts. Anything else gets 401 and never reaches it.
 */
async function authenticate(request: Request, env: AuthEnv): Promise<Request | Response> {
  const url = new URL(request.url);
  let identity: Identity | null = null;

  if (env.AUTH_DEV_BYPASS === "true" && LOCAL_HOSTS.has(url.hostname) && url.searchParams.get("devUser")) {
    identity = { userId: url.searchParams.get("devUser")!, role: roleFrom(url.searchParams.get("devRole")) };
  } else if (env.CLERK_JWT_KEY) {
    identity = await verifySessionToken(url.searchParams.get("token") ?? "", {
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  } else {
    console.error("CLERK_JWT_KEY is not set: refusing every connection");
  }
  if (!identity) return new Response("Unauthorized", { status: 401 });

  for (const key of ["token", "devUser", "devRole"]) url.searchParams.delete(key);
  return withIdentity(new Request(url, request), identity);
}

/** WebSocket and RPC traffic for agents goes to their Durable Objects, signed in; everything else is the UI's static assets. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = env as unknown as AuthEnv;
    return (
      (await routeAgentRequest(request, env, {
        onBeforeConnect: (req) => authenticate(req, auth),
        onBeforeRequest: (req) => authenticate(req, auth),
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
