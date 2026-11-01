import type { z } from "zod";
import type { CheckQuestion, Intervention } from "../interventions/templates.js";
import type { Citation } from "../course/schema.js";
import type { PageImage, Provenance, TutorAction } from "../media/contracts.js";
import type { PersonalKind, PersonalStatus } from "../storage/tutor.js";

// The tutor's shapes: what a turn takes and returns, the personal blocks it makes, and the seam to the
// model (one step of a tool loop), so tests run the loop on scripted fakes.

/** What the dock sends: the lesson and section in view, and what the learner typed or said. */
export interface TutorInput {
  lesson: string;
  section?: string;
  text: string;
  /** A "+" shortcut instead of the learner's own words: personal rewrites are then shared (no words of their own). */
  shortcut?: "explain" | "example" | "quiz";
}

/** What the dock shows while a turn runs, and the reply as it is written. */
export type TutorEvent = { type: "step"; label: string } | { type: "text"; delta: string };

/** A personal block, as a turn names it (the page fetches it with personalBlocks). */
export interface PersonalBlockRef {
  id: string;
  section: string;
  kind: PersonalKind;
  status: PersonalStatus;
}

/** A question the tutor asks before explaining: one option list, no answer key. */
export interface TutorAsk {
  id: string;
  lesson: string;
  prompt: string;
  options: string[];
}

export interface TutorTurnResult {
  reply: string;
  actions: TutorAction[];
  blocks: PersonalBlockRef[];
  ask?: TutorAsk;
  model_calls: number;
  /** Why the loop stopped early, if it did (over budget, a timeout). */
  stopped?: string;
}

/** One piece of a personal block. Practice questions reach the browser without their answers (see PublicPiece). */
export type PersonalPiece =
  | { kind: "text"; markdown: string; cites: Citation[] }
  | { kind: "check"; check: CheckQuestion }
  | { kind: "image"; id: string; caption: string }
  | { kind: "widget"; intervention: Intervention }
  | { kind: "storyboard"; title: string; frames: StoryFrame[] };

export interface StoryFrame {
  caption: string;
  narration: string;
  /** A generated image id, for at most two frames. */
  image?: string;
}

/** A piece as the learner's browser gets it: a practice question without which option is right. */
export type PublicPiece = Exclude<PersonalPiece, { kind: "check" }> | { kind: "check"; prompt: string; options: string[] };

/** A personal block as the page shows it. */
export interface PersonalBlock {
  id: string;
  lesson: string;
  section: string;
  kind: PersonalKind;
  status: PersonalStatus;
  pieces: PublicPiece[];
  provenance: Provenance | null;
  approach: string | null;
  problems: string[];
  at: string;
}

// ─── The model seam ────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type TutorMessage =
  | { role: "system" | "user"; content: string; image?: PageImage }
  | { role: "assistant"; content: string; calls: ToolCall[] }
  | { role: "tool"; call_id: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
}

/** One model step: the text it wrote (streamed through `onText`) and the tools it chose. */
export interface ModelStep {
  text: string;
  calls: ToolCall[];
}

export interface TutorModel {
  step(messages: readonly TutorMessage[], tools: readonly ToolSpec[], onText: (delta: string) => void, signal: AbortSignal): Promise<ModelStep>;
}
