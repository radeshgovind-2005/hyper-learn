import type { Change } from "../releases/changes.js";
import type { BuildStep } from "../generate/types.js";

// The contract between owner edits (src/edit) and the app (CourseService), like src/generate/types.ts
// for builds: an edit is a pure function of the course, its sources, the request and the models.

/** Section rewrites an owner can ask for in one click; each maps to a learning-science technique. */
export const EDIT_PRESETS = {
  worked_example: "Add a worked example: solve one concrete problem from the pages step by step, saying why each step is taken.",
  smaller_steps: "Break the explanation into smaller steps: short paragraphs or a numbered list, one idea per step.",
  conversational: "Rewrite it in a conversational tone: speak to the learner as \"you\", in plain sentences, with the same facts.",
  key_idea: "Open with the key idea in one bold sentence, and put the key terms in bold where they are explained.",
  plainer: "Use plainer language: short sentences, everyday words, and define each technical term the first time it appears.",
  practice: "Make the practice question test applying the idea to a new case, not recalling a phrase.",
} as const;
export type EditPreset = keyof typeof EDIT_PRESETS;

export type EditRequest =
  /** Rewrite one section: a preset, the owner's own words, or both. */
  | { kind: "tune"; section_id: string; preset?: EditPreset; instruction?: string }
  /** Anything, in the owner's words: the editor agent decides which sections, lessons or questions change. */
  | { kind: "ask"; instruction: string }
  /** A file added after the build: the editor agent proposes what it adds to the course. */
  | { kind: "add_source"; source_id: string; instruction?: string };

/** One line of the proposal as the owner reviews it. */
export interface EditSummaryItem {
  kind: "rewrite" | "new_section" | "new_lesson" | "new_questions";
  title: string;
  /** The lesson it is in (for a new lesson: itself). */
  lesson: string;
  /** Markdown before and after, for rewrites and new sections. */
  before?: string;
  after?: string;
  questions?: number;
  /** Doubts the fact checker kept about this part. */
  warnings?: string[];
}

export interface EditProposal {
  /** The release (or draft) the changes apply to. */
  base_version: string;
  changes: Change[];
  summary: EditSummaryItem[];
  /** The editor agent's words to the owner. */
  reply: string;
}

export type EditResult =
  | { ok: true; proposal: EditProposal; warnings: string[]; model_calls: number }
  | { ok: false; problems: string[]; warnings: string[]; model_calls: number };

export type EditStep = BuildStep;
