import type { QuizItem } from "../assessment/items.js";
import type { Target } from "../coach/diagnose.js";
import type { PersonalSection } from "../coach/repair.js";
import type { CourseSnapshot } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import { ANSWER_OVERLAP_LIMIT, overlap, PROMPT_OVERLAP_LIMIT, quizTexts } from "../interventions/checks.js";
import { type Intervention, interventionQuestions, interventionTexts, InterventionSchema } from "../interventions/templates.js";
import type { Provenance } from "../media/contracts.js";
import type { PersonalRow } from "../storage/tutor.js";
import type { PersonalBlock, PersonalPiece, PublicPiece } from "./types.js";

// Personal blocks: what the tutor makes for one learner, shown under a section and marked "Made for you".
// Pure helpers here; the service stores them and runs the slow parts. Practice questions reach the
// browser without their answers, and every block says why it is there (its provenance).

/** Pieces as the learner's browser gets them: practice questions without which option is right. */
export function publicPieces(pieces: readonly PersonalPiece[]): PublicPiece[] {
  return pieces.map((p) => (p.kind === "check" ? { kind: "check", prompt: p.check.prompt, options: p.check.options.map((o) => o.text) } : p));
}

export function toPersonalBlock(row: PersonalRow): PersonalBlock {
  return {
    id: row.id,
    lesson: row.lesson,
    section: row.section,
    kind: row.kind,
    status: row.status,
    pieces: publicPieces(JSON.parse(row.pieces) as PersonalPiece[]),
    provenance: row.provenance ? (JSON.parse(row.provenance) as Provenance) : null,
    approach: row.approach,
    problems: row.problems ? (JSON.parse(row.problems) as string[]) : [],
    at: row.at,
  };
}

/** A written personal lesson as pieces: its text blocks (each with its pages) and its practice question. */
export function piecesFromRepair(repair: PersonalSection): PersonalPiece[] {
  return [...repair.section.blocks.map((b) => ({ kind: "text" as const, markdown: b.markdown, cites: b.cites })), { kind: "check" as const, check: repair.section.check }];
}

export function pagesOf(pieces: readonly PersonalPiece[]): Citation[] {
  const pages: Citation[] = [];
  for (const p of pieces) {
    if (p.kind !== "text") continue;
    for (const c of p.cites) if (!pages.some((x) => x.source === c.source && x.page === c.page)) pages.push({ source: c.source, page: c.page });
  }
  return pages;
}

/** The fact check's verdict from the doubts it kept: none means supported; a check that couldn't run means unchecked. */
export function verdictOf(doubts: readonly string[]): Provenance["fact_check"] {
  if (doubts.length === 0) return "supported";
  return doubts.some((d) => /couldn't be fact-checked/i.test(d)) ? "unchecked" : "doubted";
}

/** What the learner did that this block answers, in a line they recognise. */
export interface Evidence {
  /** Their own words, if they gave any. */
  note?: string;
  /** A wrong answer: the question and what they chose (and how sure they were). */
  wrong?: { prompt: string; chose: string; sure?: string };
}

export function madeFor(evidence: Evidence): string {
  const quote = (text: string, max: number) => `"${text.replace(/\s+/g, " ").trim().slice(0, max)}${text.length > max ? "…" : ""}"`;
  if (evidence.wrong?.chose) return `you ${evidence.wrong.sure ? `picked, ${evidence.wrong.sure},` : "picked"} ${quote(evidence.wrong.chose, 80)} on ${quote(evidence.wrong.prompt, 80)}`;
  if (evidence.wrong) return `you missed ${quote(evidence.wrong.prompt, 100)}`;
  if (evidence.note) return `you said ${quote(evidence.note, 120)}`;
  return "you asked for another way to see this section";
}

/** The target a rewrite of a section aims at: a misconception or objective the evidence named, else the section's objective. */
export function targetForSection(snapshot: CourseSnapshot, lesson: string, section: string, named?: Target): Target {
  if (named && named.kind !== "ready") return named;
  const objective = (snapshot.objectives ?? []).find((o) => o.lesson === lesson && o.sections.includes(section));
  if (objective) return { kind: "objective", id: objective.id, lesson, why: "The section the learner asked about" };
  // A course without objectives: the lesson itself is the unit, as the coach's diagnosis treats it.
  return { kind: "gap", lesson, why: "The section the learner asked about" };
}

/** Problems with a widget spec (empty = fine): the template schema, no markup, one right answer, nothing that gives the quiz away. */
export function widgetProblems(spec: unknown, quiz: readonly QuizItem[]): { widget?: Intervention; problems: string[] } {
  const parsed = InterventionSchema.safeParse(spec);
  if (!parsed.success) return { problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(spec)"}: ${i.message}`) };
  const widget = parsed.data;
  const problems: string[] = [];
  for (const value of interventionTexts(widget)) if (/<\s*[a-z!/]|javascript:|\]\(\s*[a-z]+:/i.test(value)) problems.push(`markup or links are not allowed: "${value.slice(0, 60)}"`);
  for (const [i, q] of interventionQuestions(widget).entries()) {
    const right = q.options.filter((o) => o.correct);
    if (right.length !== 1) problems.push(`question ${i + 1} must have exactly one correct option (has ${right.length})`);
    for (const item of quiz) {
      const { prompts, answers } = quizTexts(item);
      if (prompts.some((p) => overlap(q.prompt, p) >= PROMPT_OVERLAP_LIMIT)) problems.push(`question ${i + 1} repeats a quiz question`);
      if (right[0] && answers.some((a) => overlap(right[0]!.text, a) >= ANSWER_OVERLAP_LIMIT)) problems.push(`question ${i + 1}'s answer gives away a quiz question`);
    }
  }
  if (widget.template === "step_through") {
    widget.frames.forEach((f, i) => {
      if (f.highlight !== null && f.highlight >= f.messages.length) problems.push(`frame ${i + 1}: highlight out of range`);
    });
  }
  return problems.length > 0 ? { problems: [...new Set(problems)] } : { widget, problems };
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Whether the learner's words quote one of the questions waiting for them (asking the tutor to answer their exam). */
export function quotesPending(text: string, pending: readonly QuizItem[]): boolean {
  if (text.trim().length < 20) return false;
  return pending.some((item) => quizTexts(item).prompts.some((p) => overlap(text, p) >= PROMPT_OVERLAP_LIMIT));
}

/** Replaces a reply that states the right answer to a question waiting for the learner. */
export function answerGuard(pending: readonly QuizItem[]): (reply: string) => string {
  const answers = pending.flatMap((item) => quizTexts(item).answers.map(norm)).filter((a) => a.length >= 8);
  return (reply) => {
    const said = norm(reply);
    return answers.some((a) => said.includes(a))
      ? "I can't give you the answer to a question on your quiz, but I can help with the idea behind it. Tell me which part is confusing."
      : reply;
  };
}
