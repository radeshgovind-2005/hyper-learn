import type { Embedder, Guard } from "../src/guards/guards.js";

// Workers AI behind the harness's Guard and Embedder interfaces. Both fail open: if Workers AI is
// unavailable (not logged in locally, quota), the check is skipped and the code checks still run.

const LLAMA_GUARD = "@cf/meta/llama-guard-3-8b";
const EMBEDDINGS = "@cf/baai/bge-base-en-v1.5";

/** Llama Guard answers "safe", or "unsafe" and the violated categories (S1–S14). */
function parseGuard(output: unknown): { safe: boolean; categories: string[] } {
  const response = (output as { response?: unknown })?.response ?? output;
  if (response && typeof response === "object" && "safe" in response) {
    const r = response as { safe: boolean; categories?: string[] };
    return { safe: r.safe, categories: r.categories ?? [] };
  }
  const text = String(response).trim();
  return { safe: !/^unsafe/i.test(text), categories: text.match(/S\d+/g) ?? [] };
}

export function workersAiGuard(ai: Ai): Guard {
  return {
    async check(texts) {
      try {
        const output = await ai.run(LLAMA_GUARD as Parameters<Ai["run"]>[0], {
          messages: [{ role: "assistant", content: texts.join("\n\n") }],
        } as never);
        return parseGuard(output);
      } catch (error) {
        console.warn("Llama Guard unavailable; skipping the safety check:", error);
        return { safe: true, categories: [] };
      }
    },
  };
}

export function workersAiEmbedder(ai: Ai): Embedder {
  return {
    async embed(texts) {
      try {
        const output = (await ai.run(EMBEDDINGS as Parameters<Ai["run"]>[0], { text: [...texts] } as never)) as { data: number[][] };
        return output.data;
      } catch (error) {
        console.warn("Embeddings unavailable; skipping the paraphrase check:", error);
        return texts.map(() => []); // empty vectors: no similarity, so nothing is flagged
      }
    },
  };
}
