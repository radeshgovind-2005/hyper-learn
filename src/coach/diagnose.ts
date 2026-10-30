import { type Grade, gradeItem } from "../assessment/grade.js";
import type { QuizItem, Response } from "../assessment/items.js";
import type { CourseSnapshot, LessonNode } from "../course/compile.js";
import { seededRandom } from "../simulation/random.js";

// The study coach, part one: where is this learner? A short diagnostic spans the lesson they are on and
// the lessons it builds on, so a wrong answer can be traced to its root. Code scores it into a small
// knowledge map and picks the ONE thing to repair now: the deepest cause first (a gap in an earlier
// lesson), then a misconception, then the weakest objective. Like a knowledge-space "ready to learn"
// fringe: fix what the rest depends on before polishing the top.

/** What the coach repairs. */
export type Target =
  | { kind: "gap"; lesson: string; objective?: string; why: string }
  | { kind: "misconception"; id: string; lesson: string; why: string }
  | { kind: "objective"; id: string; lesson: string; why: string }
  | { kind: "ready"; lesson: string; why: string };

export const targetKey = (t: Target) => (t.kind === "misconception" || t.kind === "objective" ? `${t.kind}:${t.id}` : `${t.kind}:${t.lesson}${t.kind === "gap" && t.objective ? `:${t.objective}` : ""}`);

export interface DiagnosticQuestion {
  lesson: string;
  item: QuizItem;
}

export interface ObjectiveState {
  id: string;
  lesson: string;
  statement: string;
  state: "strong" | "shaky" | "missing";
}

export interface DiagnosisResult {
  /** One row per objective the diagnostic touched (lessons without objectives: one per lesson). */
  map: ObjectiveState[];
  /** Misconceptions the answers showed, most frequent first. */
  misconceptions: { id: string; belief: string; count: number }[];
  /** Earlier lessons the answers point back to. */
  gaps: string[];
  /** The one thing to repair now, and what comes after it. */
  priority: Target;
  next: Target[];
  /** The wrong answers, for the repair to speak to ("you chose …"). */
  wrong: { item: string; lesson: string; prompt: string; chose: string }[];
  score: number;
}

const MAX_FOCUS = 4;
const MAX_PREREQ_LESSONS = 3;

/** Earlier lessons this one builds on, nearest first (breadth first over prerequisites). */
export function prerequisiteChain(snapshot: CourseSnapshot, lessonId: string, max = MAX_PREREQ_LESSONS): LessonNode[] {
  const byId = new Map(snapshot.lessons.filter((l) => !l.archived).map((l) => [l.id, l]));
  const out: LessonNode[] = [];
  const queue = [...(byId.get(lessonId)?.prerequisites ?? [])];
  const seen = new Set<string>([lessonId]);
  while (queue.length > 0 && out.length < max) {
    const id = queue.shift()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!);
    queue.push(...byId.get(id)!.prerequisites);
  }
  return out;
}

/** Items that can say something when answered wrongly: they have a tagged wrong answer (gap or misconception). */
const diagnostic = (item: QuizItem) => JSON.stringify(item).includes('"misconception"') || JSON.stringify(item).includes('"reveals_gap_in"');

/**
 * The questions: one per objective of the focus lesson (up to 4), then one from each of up to three
 * lessons it builds on. Unseen questions first, diagnostic ones preferred; order shuffled by `seed`.
 */
export function drawDiagnostic(snapshot: CourseSnapshot, lessonId: string, { seen = [], seed }: { seen?: readonly string[]; seed: number }): DiagnosticQuestion[] {
  const lesson = snapshot.lessons.find((l) => l.id === lessonId && !l.archived);
  if (!lesson) throw new Error(`No lesson "${lessonId}"`);
  const random = seededRandom(seed);
  const seenSet = new Set(seen);
  const rank = (items: readonly QuizItem[]) =>
    [...items]
      .filter((i) => !i.pilot)
      .map((item) => ({ item, key: (seenSet.has(item.id) ? 2 : 0) + (diagnostic(item) ? 0 : 1) + random() }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item);

  const picked: DiagnosticQuestion[] = [];
  const objectives = (snapshot.objectives ?? []).filter((o) => o.lesson === lesson.id);
  if (objectives.length > 0) {
    for (const o of objectives.slice(0, MAX_FOCUS)) {
      const item = rank(lesson.quiz.filter((q) => q.objective === o.id))[0];
      if (item) picked.push({ lesson: lesson.id, item });
    }
  } else {
    for (const item of rank(lesson.quiz).slice(0, MAX_FOCUS)) picked.push({ lesson: lesson.id, item });
  }
  for (const prereq of prerequisiteChain(snapshot, lesson.id)) {
    const item = rank(prereq.quiz)[0];
    if (item) picked.push({ lesson: prereq.id, item });
  }
  // Fisher–Yates, so the order doesn't give away which lesson a question is from.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picked[i], picked[j]] = [picked[j]!, picked[i]!];
  }
  return picked;
}

/** The text of what the learner chose, for single and two-tier items (others: their grade is enough). */
function chosen(item: QuizItem, response: Response): string {
  if ((item.type === "single_choice" || item.type === "two_tier") && Array.isArray(item.options)) {
    const index = item.type === "two_tier" ? (response as number[])[0] : (response as number);
    return typeof index === "number" ? (item.options[index]?.text ?? "") : "";
  }
  if (item.type === "multi_select") return (response as number[]).map((i) => item.options[i]?.text).filter(Boolean).join("; ");
  return "";
}

/** Scores the diagnostic and ranks what to repair. Throws if an answer doesn't fit its question. */
export function scoreDiagnostic(snapshot: CourseSnapshot, focus: string, questions: readonly DiagnosticQuestion[], answers: readonly Response[]): DiagnosisResult {
  if (answers.length !== questions.length) throw new Error(`Answer all ${questions.length} questions`);
  const grades: Grade[] = questions.map((q, i) => gradeItem(q.item, answers[i]!, q.lesson));
  const order = new Map(snapshot.lessons.map((l, i) => [l.id, i]));
  const lessonTitle = (id: string) => snapshot.lessons.find((l) => l.id === id)?.title ?? id;
  const objectives = snapshot.objectives ?? [];

  // The map: per objective, from the questions on it; lessons without objectives count as one unit.
  const map: ObjectiveState[] = [];
  questions.forEach((q, i) => {
    const o = q.item.objective ? objectives.find((x) => x.id === q.item.objective) : undefined;
    const id = o?.id ?? q.lesson;
    const state = grades[i]!.correct ? "strong" : grades[i]!.score > 0 ? "shaky" : "missing";
    const existing = map.find((m) => m.id === id);
    const rankState = { strong: 0, shaky: 1, missing: 2 } as const;
    if (!existing) map.push({ id, lesson: q.lesson, statement: o?.statement ?? lessonTitle(q.lesson), state });
    else if (rankState[state] > rankState[existing.state]) existing.state = state;
  });
  map.sort((a, b) => (order.get(a.lesson) ?? 0) - (order.get(b.lesson) ?? 0));

  const counts = new Map<string, number>();
  const gapLessons = new Set<string>();
  questions.forEach((q, i) => {
    for (const e of grades[i]!.errors) {
      if (e.misconception) counts.set(e.misconception, (counts.get(e.misconception) ?? 0) + 1);
      if (e.points_to !== focus && e.points_to !== q.lesson) gapLessons.add(e.points_to);
    }
    // A wrong answer on an earlier lesson's own question is a gap in that lesson.
    if (!grades[i]!.correct && q.lesson !== focus) gapLessons.add(q.lesson);
  });
  const misconceptions = [...counts]
    .map(([id, count]) => ({ id, count, belief: snapshot.misconceptions.find((m) => m.id === id)?.belief ?? id }))
    .sort((a, b) => b.count - a.count);
  const gaps = [...gapLessons].filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);

  const targets: Target[] = [];
  // 1. Gaps, deepest (earliest) first: everything after them builds on them.
  for (const lesson of gaps) {
    const missed = questions.find((q, i) => q.lesson === lesson && !grades[i]!.correct);
    targets.push({
      kind: "gap",
      lesson,
      ...(missed?.item.objective && { objective: missed.item.objective }),
      why: `Some answers point back to "${lessonTitle(lesson)}". It's what the rest builds on, so it comes first.`,
    });
  }
  // 2. Misconceptions, most often shown first.
  for (const m of misconceptions) {
    const lesson = snapshot.misconceptions.find((x) => x.id === m.id)?.lesson ?? focus;
    targets.push({ kind: "misconception", id: m.id, lesson, why: `${m.count > 1 ? `${m.count} answers` : "An answer"} followed a common mix-up: "${m.belief}"` });
  }
  // 3. Objectives of the focus lesson that were missed or shaky, in reading order.
  for (const o of map.filter((m) => m.lesson === focus && m.state !== "strong" && objectives.some((x) => x.id === m.id))) {
    targets.push({ kind: "objective", id: o.id, lesson: focus, why: `You're ${o.state === "missing" ? "not there yet" : "partly there"} on: ${o.statement}` });
  }
  const priority: Target = targets[0] ?? { kind: "ready", lesson: focus, why: "Every answer was right: you're ready for the exam." };

  const wrong = questions.flatMap((q, i) => (grades[i]!.correct ? [] : [{ item: q.item.id, lesson: q.lesson, prompt: q.item.prompt, chose: chosen(q.item, answers[i]!) }]));
  const score = grades.reduce((s, g) => s + g.score, 0) / Math.max(1, grades.length);
  return { map, misconceptions, gaps, priority, next: targets.slice(1), wrong, score };
}
