import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getSystemPrompt } from "../agents.js";
import { citedPage, type Source } from "../course/sources.js";
import { type GroundingVerdict, GroundingVerdictSchema } from "../generate/schemas.js";
import { ModelProvider } from "../models.js";
import { pagesOf } from "./personal.js";
import type { PersonalPiece } from "./types.js";

// An independent check of a personal rewrite by a different model family (Muse Wonder), once, on the
// final text only: two families are less likely to share a mistake. Text out only, so it can't write
// anything; a disagreement becomes "doubted" on the block's provenance.

export type Verifier = (provider: ModelProvider, input: { sources: readonly Source[]; pieces: readonly PersonalPiece[] }) => Promise<GroundingVerdict>;

export const VERIFIER_MODEL = "muse-wonder-1.0";
const MAX_PAGE_CHARS = 6_000;

export function verifierPrompt(sources: readonly Source[], pieces: readonly PersonalPiece[]): string {
  const text = pieces.flatMap((p, i) => (p.kind === "text" ? [`[${i + 1}] (cites ${p.cites.map((c) => `${c.source} p.${c.page}`).join(", ")})\n${p.markdown}`] : [])).join("\n\n");
  const pages = pagesOf(pieces).map((ref) => `<source id="${ref.source}" page="${ref.page}">\n${(citedPage(sources, ref) ?? "").slice(0, MAX_PAGE_CHARS)}\n</source>`);
  return [`<lesson>\n${text}\n</lesson>`, ...pages, "Which claims in the lesson are not supported by the pages they cite?"].join("\n\n");
}

/** Muse Wonder on the course's own endpoint and key: the provider's settings with the model swapped. */
export const wonderVerifier: Verifier = async (provider, { sources, pieces }) => {
  const wonder = provider.withModel(VERIFIER_MODEL);
  const model = wonder.structured(GroundingVerdictSchema, "check_grounding", "reasoning");
  return model.invoke([new SystemMessage(getSystemPrompt("verifier")), new HumanMessage(verifierPrompt(sources, pieces))]);
};
