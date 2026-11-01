export interface MetaClientConfig {
  baseURL: string;
  apiKey: string;
  /** Per attempt. Default 60 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors, 408, 409, 429 and 5xx. Default 2. */
  retries?: number;
}

const RETRYABLE = new Set([408, 409, 429]);

/** A fetch to Meta's API with a timeout and bounded retries. The key goes in the header and nowhere else. */
export async function metaFetch(config: MetaClientConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const { timeoutMs = 60_000, retries = 2 } = config;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.apiKey}`);
  if (!headers.has("content-type") && typeof init.body === "string") headers.set("content-type", "application/json");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${config.baseURL.replace(/\/$/, "")}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || attempt >= retries || !(RETRYABLE.has(res.status) || res.status >= 500)) return res;
    } catch (error) {
      if (attempt >= retries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 3 ** attempt));
  }
}
