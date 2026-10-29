// Optional AI checks behind small interfaces, so the harness never depends on a service being up.
// In the Worker these are Llama Guard and Workers AI embeddings; in tests, fakes; without them, the
// code checks still run and these steps are skipped.

/** A safety classifier for text the course will show learners (e.g. Llama Guard). */
export interface Guard {
  check(texts: readonly string[]): Promise<{ safe: boolean; categories: string[] }>;
}

/** A text embedding model (e.g. bge-base-en-v1.5). */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Cosine similarity at which a question counts as a paraphrase of a quiz question. */
export const PARAPHRASE_SIMILARITY = 0.9;

/**
 * Questions that mean the same as a quiz question even with different words: word overlap misses
 * these, embeddings catch them. Returns one problem per leaking question.
 */
export async function paraphraseLeaks(
  questions: readonly string[],
  quiz: readonly { id: string; prompt: string }[],
  embedder: Embedder,
  threshold = PARAPHRASE_SIMILARITY,
): Promise<string[]> {
  if (questions.length === 0 || quiz.length === 0) return [];
  const vectors = await embedder.embed([...questions, ...quiz.map((q) => q.prompt)]);
  const problems: string[] = [];
  questions.forEach((_, i) => {
    quiz.forEach((item, j) => {
      const similarity = cosine(vectors[i]!, vectors[questions.length + j]!);
      if (similarity >= threshold) problems.push(`question ${i + 1} paraphrases quiz question "${item.id}" (similarity ${similarity.toFixed(2)})`);
    });
  });
  return problems;
}
