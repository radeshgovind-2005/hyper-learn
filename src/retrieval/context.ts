import { wrongOptions } from "../assessment/answers.js";
import { type CourseSnapshot, isTextBlock, liveInterventions } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import { quizTexts } from "../interventions/checks.js";
import { EXEMPLARS } from "../interventions/exemplars.js";
import type { Template } from "../interventions/templates.js";
import { describeIntervention } from "../releases/changes.js";
import type { Release } from "../releases/release.js";
import type { NamedMisconception } from "../state.js";

// Graph retrieval: an agent's context is assembled by walking the course graph, not by vector search.
// The whole course would fit in a large context window, but exact, budgeted context is cheaper, keeps
// the local 4k-context model usable, and makes every fact the agent sees traceable to an id.

/** Characters of context an Author call gets, whatever the model's window (≈ 1.7k tokens). */
export const AUTHOR_CONTEXT_BUDGET = 6_000;

/** Keeps `parts` in order, shortening the one marked `elastic` so the total fits `budget`. */
function fit(parts: { text: string; elastic?: boolean }[], budget: number): string {
  const fixed = parts.filter((p) => !p.elastic).reduce((n, p) => n + p.text.length + 2, 0);
  return parts
    .map((p) => {
      if (!p.elastic) return p.text;
      const room = Math.max(200, budget - fixed);
      return p.text.length > room ? `${p.text.slice(0, room - 1)}…` : p.text;
    })
    .join("\n\n");
}

export interface AuthorContextInput {
  snapshot: CourseSnapshot;
  course: Course;
  lessonId: string;
  misconception: string;
  evidence?: NamedMisconception;
  templates: readonly Template[];
  /** Every release so far: past trials of interventions for the same misconception are shown with their outcome. */
  history: readonly Release[];
}

/** Everything the Author needs to write one intervention, and nothing else. */
export function authorContext({ snapshot, course, lessonId, misconception, evidence, templates, history }: AuthorContextInput): string {
  const belief = course.getMisconception(misconception);
  const lesson = snapshot.lessons.find((l) => l.id === lessonId);
  if (!belief || !lesson) throw new Error(`No misconception "${misconception}" or lesson "${lessonId}"`);

  // Quiz answers that reveal the belief, anywhere in the course: the Author must not reuse them.
  const revealing = course.lessons.flatMap((l) =>
    l.quiz.flatMap((item) =>
      wrongOptions(item, l.id).some((o) => o.reveals.misconception === misconception)
        ? [`- ${item.id}: "${item.prompt}" (correct answer: "${quizTexts(item).answers[0]?.slice(0, 120)}")`]
        : [],
    ),
  );

  const sections = lesson.sections
    .filter((s) => !s.archived)
    .map((s) => {
      const body = s.blocks.flatMap((b) => (isTextBlock(b) && !b.archived ? [b.markdown] : [])).join("\n");
      return `[${s.id}] ${s.title || "(intro)"}\n${body}`;
    })
    .join("\n\n");

  // Intervention memory: what was tried for this belief before, and what the trial decided.
  const tried = history.flatMap((release) =>
    release.changes.flatMap((change) =>
      change.op === "add_block" && change.intervention.targets === misconception && !release.released_from
        ? [`- ${release.version}: ${describeIntervention(change.intervention)} → ${release.status}${release.decision ? ` (${release.decision.reasons[0]})` : ""}`]
        : [],
    ),
  );
  const live = liveInterventions(snapshot).filter((i) => i.intervention.targets === misconception);
  const example = EXEMPLARS.find((e) => templates.includes(e.template) && e.targets !== misconception) ?? EXEMPLARS.find((e) => templates.includes(e.template));

  return fit(
    [
      {
        text:
          `Misconception "${misconception}" (taught in ${lessonId}): ${belief.belief}\n` +
          (evidence
            ? `Evidence: shown in ${Math.round(evidence.share * 100)}% of failed attempts; ${Math.round(evidence.confident * 100)}% of those answers were given with high certainty.`
            : ""),
      },
      { text: `Allowed templates: ${templates.join(", ")}.` },
      { text: `Quiz questions that reveal this belief. Do NOT reuse their wording or answers:\n${revealing.join("\n") || "- none"}` },
      {
        text:
          `Already tried for this belief:\n${tried.join("\n") || "- nothing"}` +
          (live.length > 0 ? `\nLive now: ${live.map((i) => `${i.block_id} (${i.intervention.template})`).join(", ")} — use a different template.` : ""),
      },
      ...(example ? [{ text: `Format example (a different belief; write your own content):\n${JSON.stringify(example)}` }] : []),
      { text: `Lesson "${lesson.title}" sections (attach to one by its [id]):\n${sections}`, elastic: true },
    ],
    AUTHOR_CONTEXT_BUDGET,
  );
}
