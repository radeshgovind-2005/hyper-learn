import { END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAgent, getSystemPrompt, renderTemplate } from "../agents.js";
import { courseFromSnapshot, isTextBlock, liveInterventions } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import { paraphraseLeaks } from "../guards/guards.js";
import { checkIntervention } from "../interventions/checks.js";
import { allowedTemplates, interventionQuestions, interventionTexts } from "../interventions/templates.js";
import { getStructuredModel, type Invokable } from "../models.js";
import type { ReleaseStore } from "../releases/release.js";
import type { Harness } from "./release.js";
import { authorContext } from "../retrieval/context.js";
import { type Draft, DraftSchema, MAX_AUTHOR_ATTEMPTS, type ReflectionVerdict, ReflectionVerdictSchema, type State, type StateUpdate } from "../state.js";
import { logNode } from "../utils/logger.js";

// Authoring, for proposals that need new content (add_intervention): the Author writes a draft, code
// checks it, then the Content Reviewer judges what code can't. A rejected draft goes back with the
// problems, at most MAX_AUTHOR_ATTEMPTS times.

export type AuthorModel = Invokable<Draft>;
export type ContentReviewerModel = Invokable<ReflectionVerdict>;

export const createAuthorModel = (): AuthorModel => getStructuredModel(DraftSchema, "write_intervention", getAgent("author").model);
export const createContentReviewerModel = (): ContentReviewerModel =>
  getStructuredModel(ReflectionVerdictSchema, "review_intervention", getAgent("reviewer").model);

/** The proposal being authored, and which templates code allows for it. */
function target(state: State) {
  const proposal = state.proposed_mutation;
  if (proposal?.action !== "add_intervention" || !proposal.misconception_id) throw new Error("authoring needs an add_intervention proposal");
  const evidence = state.performance_data
    .find((n) => n.node_id === proposal.node_id)
    ?.misconceptions.find((m) => m.id === proposal.misconception_id);
  return { lessonId: proposal.node_id, misconception: proposal.misconception_id, evidence, templates: allowedTemplates(evidence?.confident ?? 0) };
}

export function createAuthorNode(store: ReleaseStore, model: AuthorModel = createAuthorModel()) {
  return async function authorNode(state: State): Promise<StateUpdate> {
    const { lessonId, misconception, evidence, templates } = target(state);
    const attempt = state.author_attempts + 1;
    logNode("author", `Writing an intervention for "${misconception}" in ${lessonId} (${templates.join(" or ")}) — attempt ${attempt}`);

    const live = store.live();
    const messages = [
      new SystemMessage(getSystemPrompt("author")),
      new HumanMessage(
        authorContext({
          snapshot: live.snapshot,
          course: courseFromSnapshot(live.snapshot),
          lessonId,
          misconception,
          ...(evidence && { evidence }),
          templates,
          history: store.all(),
        }),
      ),
    ];
    if (state.draft && state.content_verdict && !state.content_verdict.approved) {
      messages.push(
        new HumanMessage(renderTemplate("author", "retry", { draft: JSON.stringify(state.draft), critique: state.content_verdict.critique })),
      );
    }

    const draft = await model.invoke(messages);
    logNode("author", `Drafted a ${draft.intervention.template} for ${draft.section_id}`);
    return { draft, author_attempts: attempt };
  };
}

/** Code checks for a draft: the template is one code allows, the section is real, and the intervention passes every check. */
export function checkDraft(state: State, store: ReleaseStore): string[] {
  const draft = state.draft;
  if (!draft) return ["no draft"];
  const { lessonId, misconception, templates } = target(state);
  const snapshot = store.live().snapshot;
  const problems: string[] = [];

  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) return [`not a valid draft: ${parsed.error.message}`];
  if (!templates.includes(draft.intervention.template)) {
    problems.push(`template "${draft.intervention.template}" isn't allowed here; use ${templates.join(" or ")}`);
  }
  const section = snapshot.lessons.find((l) => l.id === lessonId)?.sections.find((s) => s.id === draft.section_id);
  if (!section || section.archived) problems.push(`"${draft.section_id}" is not a live section of ${lessonId}`);

  problems.push(
    ...checkIntervention(draft.intervention, {
      course: courseFromSnapshot(snapshot),
      lessonId,
      misconception,
      existing: liveInterventions(snapshot).map((i) => i.intervention),
    }),
  );
  return problems;
}

/** Checks that need a model service, if the harness has one: paraphrased quiz questions, and safety. */
async function serviceChecks(draft: Draft, course: Course, { guard, embedder }: Pick<Harness, "guard" | "embedder">): Promise<string[]> {
  const problems: string[] = [];
  if (embedder) {
    const quiz = course.lessons.flatMap((l) => l.quiz.map((item) => ({ id: item.id, prompt: item.prompt })));
    problems.push(...(await paraphraseLeaks(interventionQuestions(draft.intervention).map((q) => q.prompt), quiz, embedder)));
  }
  if (guard) {
    const verdict = await guard.check(interventionTexts(draft.intervention));
    if (!verdict.safe) problems.push(`unsafe content (${verdict.categories.join(", ") || "flagged by the safety model"})`);
  }
  return problems;
}

export function createReviewContentNode(harness: Harness, model: ContentReviewerModel = createContentReviewerModel()) {
  const { store } = harness;
  return async function reviewContentNode(state: State): Promise<StateUpdate> {
    let problems = checkDraft(state, store);
    if (problems.length === 0 && state.draft) {
      problems = await serviceChecks(state.draft, courseFromSnapshot(store.live().snapshot), harness);
    }
    let verdict: ReflectionVerdict;
    if (problems.length > 0) {
      verdict = {
        approved: false,
        critique: [...problems.map((p) => `CODE CHECK: FAIL — ${p}`), "FIX: correct the problems above."].join("\n"),
      };
      logNode("reviewer", "❌ REJECTED by code checks (model not called)", verdict.critique);
    } else {
      const { lessonId } = target(state);
      const lesson = store.live().snapshot.lessons.find((l) => l.id === lessonId)!;
      const lessonText = lesson.sections
        .flatMap((s) => s.blocks.flatMap((b) => (isTextBlock(b) && !b.archived ? [b.markdown] : [])))
        .join("\n");
      logNode("reviewer", "Code checks passed. Reviewing the content...");
      verdict = await model.invoke([
        new SystemMessage(getSystemPrompt("reviewer")),
        new HumanMessage(`Lesson text:\n${lessonText}\n\nIntervention:\n${JSON.stringify(state.draft)}`),
      ]);
      logNode("reviewer", verdict.approved ? "✅ APPROVED" : "❌ REJECTED", verdict.critique);
    }
    return { content_verdict: verdict };
  };
}

export function routeFromReviewContent(state: State): "plan_release" | "author" | typeof END {
  if (state.content_verdict?.approved) return "plan_release";
  if (state.author_attempts >= MAX_AUTHOR_ATTEMPTS) {
    logNode("reviewer", `Giving up after ${state.author_attempts} draft(s) — nothing released.`);
    return END;
  }
  return "author";
}
