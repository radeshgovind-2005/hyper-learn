import "dotenv/config";
import { Agent, fetch as undiciFetch } from "undici";
import { configureModels, modelConfigFromEnv } from "../models.js";

// Node entry points (npm start, eval, loop) import this first: it reads `.env` and gives model calls a
// fetch that waits as long as MODEL_TIMEOUT_MS. Node's own fetch gives up if no response headers arrive
// within 5 minutes, and a non-streaming local model sends nothing until its whole answer is generated,
// so long calls would otherwise fail at 5 minutes whatever the timeout says.

const settings = modelConfigFromEnv(process.env);
const dispatcher = new Agent({ headersTimeout: settings.timeoutMs, bodyTimeout: settings.timeoutMs });

configureModels({
  ...settings,
  // undici's own fetch, so the dispatcher is guaranteed to be compatible with it.
  fetch: undiciFetch as unknown as typeof globalThis.fetch,
  fetchOptions: { dispatcher },
});
