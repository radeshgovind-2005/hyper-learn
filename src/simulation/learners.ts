import { randomTopologicalOrder } from "../course/graph.js";
import type { Course, PrereqGraph, QuizQuestion } from "../course/schema.js";
import { pick, seededRandom } from "./random.js";
import type { Scenario } from "./scenarios.js";

/** How simulated learners behave. Defaults keep the control scenario free of problem lessons. */
export interface LearnerModel {
  learners: number;
  /** Chance of mastering a lesson when every true prerequisite is mastered. */
  baseMastery: number;
  /** Chance a learner who mastered the lesson still answers a question wrong. */
  slip: number;
  /** Chance a learner who didn't master the lesson guesses right. */
  guess: number;
  /**
   * Chance a wrong answer is one that reveals the learner's actual gap, when such an option exists.
   * The gap is a missing prerequisite, or the lesson itself when the learner simply didn't master it.
   */
  gapPick: number;
}

export const DEFAULT_LEARNER_MODEL: LearnerModel = {
  learners: 300,
  baseMastery: 0.97,
  slip: 0.05,
  guess: 0.25,
  gapPick: 0.8,
};

/** One learner's answers to one lesson quiz, as a real platform would record them. */
export interface QuizAttempt {
  learner_id: number;
  lesson_id: string;
  /** Index of the chosen option for each question, in quiz order. */
  answers: number[];
}

export interface Simulation {
  /** The graph learners were routed through (the course graph with the scenario's faults applied). */
  published: PrereqGraph;
  attempts: QuizAttempt[];
}

/** The course graph with the scenario's removed edges. Throws if an edge doesn't exist, to catch typos. */
export function publishedGraph(course: Course, scenario: Scenario): PrereqGraph {
  const graph: Record<string, string[]> = Object.fromEntries(
    Object.entries(course.graph).map(([id, prereqs]) => [id, [...prereqs]]),
  );
  for (const [lesson, prereq] of scenario.removeEdges ?? []) {
    const prereqs = graph[lesson];
    if (!prereqs?.includes(prereq)) throw new Error(`Scenario "${scenario.id}": no edge ${prereq} → ${lesson} to remove`);
    graph[lesson] = prereqs.filter((p) => p !== prereq);
  }
  return graph;
}

function answerQuestion(
  lessonId: string,
  question: QuizQuestion,
  mastered: boolean,
  gaps: readonly string[],
  model: LearnerModel,
  random: () => number,
): number {
  const correct = question.options.findIndex((option) => option.correct);
  const answersRight = mastered ? random() >= model.slip : random() < model.guess;
  if (answersRight) return correct;

  const wrong = question.options.flatMap((option, i) => (option.correct ? [] : [i]));
  // A slip by a learner who mastered the lesson is random. Otherwise the wrong answer tends to
  // reveal the real gap: a missing prerequisite, or (untagged options) the lesson itself.
  if (mastered) return pick(wrong, random);
  const actualGaps = gaps.length > 0 ? gaps : [lessonId];
  const revealing = wrong.filter((i) => actualGaps.includes(question.options[i]!.reveals_gap_in ?? lessonId));
  const pool = revealing.length > 0 && random() < model.gapPick ? revealing : wrong;
  return pick(pool, random);
}

/**
 * Simulates learners taking the course in an order the *published* graph allows.
 * Whether they master a lesson depends on the *true* course graph: a learner who reaches a lesson
 * without its real prerequisites can't master it, and their wrong answers tend to reveal that gap.
 * Fully deterministic for a given scenario, model and seed.
 */
export function simulate(
  course: Course,
  scenario: Scenario,
  { model = DEFAULT_LEARNER_MODEL, seed = scenario.seed }: { model?: LearnerModel; seed?: number } = {},
): Simulation {
  const random = seededRandom(seed);
  const published = publishedGraph(course, scenario);
  const takers = new Map<string, number>();
  const attempts: QuizAttempt[] = [];

  for (let learner_id = 0; learner_id < model.learners; learner_id++) {
    const mastered = new Set<string>();

    for (const lessonId of randomTopologicalOrder(published, random)) {
      const cap = scenario.takers?.[lessonId];
      const taken = takers.get(lessonId) ?? 0;
      if (cap !== undefined && taken >= cap) continue;
      takers.set(lessonId, taken + 1);

      const lesson = course.getLesson(lessonId)!;
      const gaps = (course.graph[lessonId] ?? []).filter((prereq) => !mastered.has(prereq));
      const masters = gaps.length === 0 && random() < (scenario.mastery?.[lessonId] ?? model.baseMastery);
      if (masters) mastered.add(lessonId);

      const answers = lesson.quiz.map((question) => answerQuestion(lessonId, question, masters, gaps, model, random));
      attempts.push({ learner_id, lesson_id: lessonId, answers });
    }
  }

  return { published, attempts };
}
