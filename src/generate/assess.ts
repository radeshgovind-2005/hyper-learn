import { wrongOptions } from "../assessment/answers.js";
import { checkItem, type QuizItem, QuizItemSchema, type WrongAnswerTag } from "../assessment/items.js";
import type { MisconceptionDef } from "../course/schema.js";
import { type AssessmentSentence, copiedSentence, itemPrompts } from "./checks.js";
import type { PlannedLesson } from "./plan.js";
import { audienceLine, fitParts, languageLine, pageLabel, uniqueSlug } from "./prompt.js";
import type { AssessmentDraft, ItemDraft, OptionDraft } from "./schemas.js";
import type { SourceDigest } from "./sources.js";
import type { BuildInput } from "./types.js";
import type { WrittenSection } from "./write.js";

// Step 5: a lesson's misconceptions and its exam pool. The examiner refers to objectives and
// misconceptions by number and to prerequisites by the ids it was shown; code assigns every id,
// checks every tag, and refuses a pool that can't diagnose (a prerequisite or a misconception that no
// wrong answer reveals) or can't give a fresh retake.
//
// One call per objective keeps each answer short (a whole lesson's pool is up to 25 questions). The
// first call also writes the lesson's misconceptions; the others are given them, so tags agree.

export interface LessonAssessment {
  misconceptions: MisconceptionDef[];
  items: QuizItem[];
}

export const MIN_MISCONCEPTIONS = 2;
export const MAX_MISCONCEPTIONS = 4;

/** Items per objective the examiner is asked for: two full exams' worth plus one, so retakes stay fresh. */
export const poolTarget = (perObjective: number) => 2 * perObjective + 1;

export interface ExaminerContext {
  input: BuildInput;
  lesson: PlannedLesson;
  /** Every planned lesson, to describe prerequisites. */
  lessons: readonly PlannedLesson[];
  /** The lesson's written sections, by section id (missing ones are left out). */
  written: ReadonlyMap<string, WrittenSection>;
  /** What the assessments and briefs evaluate. */
  evaluated: readonly SourceDigest[];
  perObjective: number;
}

/** Which objective one examiner call writes for (0-based), and the misconceptions the first call wrote. */
export interface ExaminerPart {
  objective: number;
  /** Given to every call but the first, which writes them. */
  misconceptions?: readonly { name: string; belief: string }[];
}

export function examinerPrompt(
  { input, lesson, lessons, written, evaluated, perObjective }: ExaminerContext,
  room: number,
  retry?: string,
  part: ExaminerPart = { objective: 0 },
): string {
  const prerequisites = lesson.prerequisites.map((id) => {
    const p = lessons.find((l) => l.id === id)!;
    return `- ${id}: ${p.title}. ${p.summary}`;
  });
  const n = poolTarget(perObjective);
  const header = [
    `Course: ${input.title}`,
    `Lesson "${lesson.title}": ${lesson.summary}`,
    `Objectives (set objective to the number):\n${lesson.objectives.map((o, i) => `O${i + 1}: ${o.statement}`).join("\n")}`,
    part.misconceptions
      ? `Misconceptions of this lesson (set misconception to the number; leave misconceptions empty, they are written):\n${part.misconceptions.map((m, i) => `M${i + 1}: ${m.name}: ${m.belief}`).join("\n")}`
      : `Write ${MIN_MISCONCEPTIONS} to ${MAX_MISCONCEPTIONS} misconceptions for the whole lesson.`,
    `Write ${n} questions for objective O${part.objective + 1} only. Mix the question types.`,
    prerequisites.length > 0
      ? `Prerequisites (gap ids; most questions need a wrong option tagged with each):\n${prerequisites.join("\n")}`
      : "This lesson has no prerequisites: leave every gap null.",
    languageLine(input.language),
    audienceLine(input.audience),
  ]
    .filter(Boolean)
    .join("\n\n");
  const style = evaluated.flatMap((d) => d.points.map((p) => `- ${p.text}`)).join("\n");
  const text = lesson.sections
    .map((s) => {
      const body = written.get(s.id)?.blocks.map((b) => b.markdown).join("\n\n");
      return body ? `## ${s.title}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return fitParts(
    [
      { text: header },
      ...(style ? [{ text: style, elastic: true, before: "What the assessments evaluate (style and level only; never copy their questions):\n" }] : []),
      { text, elastic: true, before: "<lesson>\n", after: "\n</lesson>" },
      ...(retry ? [{ text: retry }] : []),
    ],
    room,
  );
}

/** One draft from the per-objective drafts: the first call's misconceptions, every call's questions in order. */
export function mergeDrafts(parts: readonly AssessmentDraft[]): { draft: AssessmentDraft; owners: number[] } {
  const owners: number[] = [];
  const items = parts.flatMap((part, k) =>
    part.items.map((item) => {
      owners.push(k);
      // Code knows which objective each call wrote for.
      return { ...item, objective: k + 1 };
    }),
  );
  return { draft: { misconceptions: parts[0]?.misconceptions ?? [], items }, owners };
}

/**
 * Sends each of a lesson's problems to the examiner call(s) that can fix it: a question's to the call that
 * wrote it (renumbered as that call saw it), an objective's to its call, the misconceptions' to the first,
 * and lesson-wide ones (a gap or misconception no question reveals, whole-course checks) to every call.
 */
export function problemsByPart(problems: readonly string[], owners: readonly number[], parts: number, lessonId: string): string[][] {
  const byPart: string[][] = Array.from({ length: parts }, () => []);
  const local = (n: number) => owners.slice(0, n - 1).filter((k) => k === owners[n - 1]).length + 1;
  // Lesson ids are slugs made by code, so they need no escaping. The validator names items and objectives by id.
  const itemId = new RegExp(`"${lessonId}-q(\\d+)"`);
  const objectiveId = new RegExp(`"${lessonId}-o(\\d+)"`);
  for (const problem of problems) {
    const question = /^question (\d+)/.exec(problem) ?? itemId.exec(problem);
    const objective = /^objective (\d+) has/.exec(problem) ?? objectiveId.exec(problem);
    const n = Number(question?.[1] ?? 0);
    const k = Number(objective?.[1] ?? 0);
    if (n > 0 && owners[n - 1] !== undefined) {
      // As the call saw it: `Question "l-q7" in "l": …` becomes `question 2 in "l": …`.
      byPart[owners[n - 1]!]!.push(problem.replace(question![0], `question ${local(n)}`).replace(/^Question question/, "question"));
    } else if (k > 0 && k <= parts) {
      byPart[k - 1]!.push(problem);
    } else if (/^write \d+ to \d+ misconceptions|^misconception \d+ states no belief/.test(problem)) {
      byPart[0]!.push(problem);
    } else {
      for (const list of byPart) list.push(problem);
    }
  }
  return byPart;
}

/** Builds a lesson's assessment from a draft, or lists every problem to send back. */
export function assessmentFromDraft(
  draft: AssessmentDraft,
  lesson: PlannedLesson,
  {
    perObjective,
    takenMisconceptions,
    sentences,
  }: { perObjective: number; takenMisconceptions: ReadonlySet<string>; sentences: readonly AssessmentSentence[] },
): { assessment?: LessonAssessment; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const m = draft.misconceptions.length;
  if (m < MIN_MISCONCEPTIONS || m > MAX_MISCONCEPTIONS) problems.push(`write ${MIN_MISCONCEPTIONS} to ${MAX_MISCONCEPTIONS} misconceptions (there are ${m})`);
  const taken = new Set(takenMisconceptions);
  const misconceptions = draft.misconceptions.map((d, i): MisconceptionDef => {
    if (!d.belief.trim()) problems.push(`misconception ${i + 1} states no belief`);
    return { id: uniqueSlug(d.name, `${lesson.id}-m${i + 1}`, taken), lesson: lesson.id, belief: d.belief.trim() || d.name };
  });

  const tagOf = (o: { correct?: boolean; gap: string | null; misconception: number | null }, where: string): WrongAnswerTag => {
    if (o.correct) return {}; // a tag on a correct option means nothing; drop it
    const tag: WrongAnswerTag = {};
    if (o.gap !== null) {
      if (lesson.prerequisites.includes(o.gap)) tag.reveals_gap_in = o.gap;
      else {
        const allowed = lesson.prerequisites.length > 0 ? `use one of ${lesson.prerequisites.join(", ")}` : "this lesson has none, so use null";
        problems.push(`${where}: gap "${o.gap}" is not a prerequisite of this lesson (${allowed})`);
      }
    }
    if (o.misconception !== null) {
      if (o.gap !== null) problems.push(`${where}: tag a gap or a misconception, not both`);
      else if (!misconceptions[o.misconception - 1]) problems.push(`${where}: misconception ${o.misconception} doesn't exist (use 1 to ${m})`);
      else tag.misconception = misconceptions[o.misconception - 1]!.id;
    }
    return tag;
  };
  const options = (list: OptionDraft[], where: string) =>
    list.map((o, j) => ({ text: o.text.trim(), correct: o.correct, ...tagOf(o, `${where}, option ${j + 1}`) }));

  const items: QuizItem[] = [];
  /** Items that pass the item rules: only these can be simulated to see what their answers reveal. */
  const sound: QuizItem[] = [];
  draft.items.forEach((d: ItemDraft, i) => {
    const where = `question ${i + 1}`;
    const objective = lesson.objectives[d.objective - 1];
    if (!objective) problems.push(`${where}: objective ${d.objective} doesn't exist (use 1 to ${lesson.objectives.length})`);
    const base = { id: `${lesson.id}-q${i + 1}`, prompt: d.prompt.trim(), pilot: false, ...(objective && { objective: objective.id }) };

    let candidate: unknown;
    switch (d.type) {
      case "single_choice":
      case "multi_select":
        candidate = { type: d.type, ...base, options: options(d.options, where) };
        break;
      case "two_tier":
        if (!d.reason_prompt?.trim()) problems.push(`${where}: a two_tier question needs a reason_prompt`);
        candidate = {
          type: d.type,
          ...base,
          options: options(d.options, `${where} (answer tier)`),
          reason_prompt: d.reason_prompt?.trim() ?? "",
          reasons: options(d.reasons, `${where} (reason tier)`),
        };
        break;
      case "ordering":
        candidate = {
          type: d.type,
          ...base,
          steps: d.steps.map((s) => s.trim()),
          patterns: d.wrong_orders.map((w, j) => ({ first: w.later - 1, second: w.earlier - 1, ...tagOf(w, `${where}, wrong order ${j + 1}`) })),
        };
        break;
    }

    const parsed = QuizItemSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${where}: ${issue.path.join(".") || d.type}: ${issue.message}`);
      return;
    }
    const item = parsed.data;
    const itemProblems = checkItem(item);
    for (const p of itemProblems) problems.push(`${where}: ${p}`);
    if (itemProblems.length === 0) {
      if (wrongOptions(item, lesson.id).length === 0) problems.push(`${where}: it has no way to answer wrongly`);
      else sound.push(item);
    }
    for (const prompt of itemPrompts(item)) {
      const copied = copiedSentence(prompt, sentences);
      if (copied) problems.push(`${where} copies an assessment question (${pageLabel(copied)}); write your own question`);
    }
    items.push(item);
  });

  const target = poolTarget(perObjective);
  lesson.objectives.forEach((objective, k) => {
    const count = items.filter((item) => item.objective === objective.id).length;
    if (count < 2 * perObjective) problems.push(`objective ${k + 1} has ${count} questions; write at least ${target}`);
    else if (count < target) warnings.push(`Objective "${objective.id}" has ${count} questions (${target} asked for): retakes may repeat questions`);
  });

  // Diagnosis checks run on the sound items, so one broken question doesn't hide a missing tag elsewhere.
  {
    const reveals = sound.map((item) => wrongOptions(item, lesson.id).map((o) => o.reveals));
    for (const prereq of lesson.prerequisites) {
      const revealing = reveals.filter((r) => r.some((w) => w.points_to === prereq)).length;
      if (revealing === 0) problems.push(`no wrong option reveals a gap in prerequisite "${prereq}"; tag one in most questions`);
      else if (revealing < sound.length / 2) {
        warnings.push(`Only ${revealing} of ${sound.length} questions in "${lesson.id}" can reveal a gap in "${prereq}": a missing prerequisite would be hard to detect`);
      }
    }
    misconceptions.forEach((mc, i) => {
      if (!reveals.some((r) => r.some((w) => w.misconception === mc.id))) problems.push(`misconception ${i + 1} ("${mc.belief.slice(0, 60)}") is not expressed by any wrong option`);
    });
  }

  return problems.length > 0 ? { problems, warnings } : { assessment: { misconceptions, items }, problems, warnings };
}
