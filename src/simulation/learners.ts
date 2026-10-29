import { gradeAttempt } from "../analytics/performance.js";
import { correctResponse, type WrongOption, wrongOptions } from "../assessment/answers.js";
import type { Certainty, QuizItem, Response } from "../assessment/items.js";
import { randomTopologicalOrder } from "../course/graph.js";
import type { LiveIntervention } from "../course/compile.js";
import type { Course, PrereqGraph } from "../course/schema.js";
import type { Template } from "../interventions/templates.js";
import { nextSteps } from "../path/route.js";
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
  /**
   * Weight of holding no named belief about a lesson the learner hasn't mastered, against a weight of 1
   * per misconception (scenarios can reweight misconceptions with `prevalence`).
   */
  noBelief: number;
  /** Chance a learner who failed masters the lesson on re-reading alone, before a retake. */
  relearn: number;
}

export const DEFAULT_LEARNER_MODEL: LearnerModel = {
  learners: 300,
  baseMastery: 0.97,
  slip: 0.05,
  guess: 0.25,
  gapPick: 0.8,
  noBelief: 1,
  relearn: 0.1,
};

/** One learner's answers to one lesson quiz, as a real platform would record them. */
export interface QuizAttempt {
  learner_id: number;
  lesson_id: string;
  /**
   * The items shown, in order, when the exam was drawn from the lesson's pool. Absent = the whole quiz in
   * quiz order (every attempt before exams were drawn, and every lesson without an exam config).
   */
  item_ids?: string[];
  /** The response to each item shown, in that order (shape depends on the item type). */
  answers: Response[];
  /** How sure the learner was of each answer. */
  certainty: Certainty[];
  /** 1 for the first attempt, 2 for a retake. */
  attempt?: number;
  /** Intervention blocks the learner was shown before this attempt. */
  exposed?: string[];
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

/** What a learner currently knows: mastered lessons, and the belief (if any) they hold about each other lesson. */
interface LearnerState {
  mastered: Set<string>;
  beliefs: Map<string, string | null>;
}

/**
 * The belief a learner holds about a lesson they haven't mastered: one of its misconceptions, or none.
 * Drawn once per learner and lesson, so a learner answers consistently with the same belief.
 */
function beliefAbout(
  lessonId: string,
  learner: LearnerState,
  course: Course,
  scenario: Scenario,
  model: LearnerModel,
  random: () => number,
): string | null {
  const held = learner.beliefs.get(lessonId);
  if (held !== undefined) return held;

  const candidates = course.misconceptions.filter((m) => m.lesson === lessonId);
  const weights = candidates.map((m) => scenario.prevalence?.[m.id] ?? 1);
  const total = weights.reduce((a, b) => a + b, model.noBelief);
  let roll = random() * total;
  let belief: string | null = null;
  for (const [i, weight] of weights.entries()) {
    if (roll < weight) {
      belief = candidates[i]!.id;
      break;
    }
    roll -= weight;
  }
  learner.beliefs.set(lessonId, belief);
  return belief;
}

function answerItem(
  lessonId: string,
  item: QuizItem,
  mastered: boolean,
  heldBeliefs: ReadonlySet<string>,
  gaps: readonly string[],
  options: readonly WrongOption[],
  model: LearnerModel,
  random: () => number,
): { response: Response; certainty: Certainty } {
  const answersRight = mastered ? random() >= model.slip : random() < model.guess;
  if (answersRight) return { response: correctResponse(item), certainty: mastered ? 3 : 1 };
  if (options.length === 0) throw new Error(`Item "${item.id}" has no wrong answers to simulate`);

  // A slip by a learner who mastered the lesson is random.
  if (mastered) return { response: pick(options, random).response, certainty: 2 };

  // Otherwise the wrong answer tends to reveal the real gap (a missing prerequisite, or the lesson
  // itself), and a learner holding a named belief is drawn to the answer that expresses it, confidently.
  const actualGaps = gaps.length > 0 ? gaps : [lessonId];
  const believing = options.filter((o) => o.reveals.misconception !== undefined && heldBeliefs.has(o.reveals.misconception));
  if (believing.length > 0 && random() < model.gapPick) {
    return { response: pick(believing, random).response, certainty: random() < 0.8 ? 3 : 2 };
  }
  // Without a matching belief, prefer answers that reveal the gap without naming a belief, so named
  // misconceptions are only counted for learners who hold them; fall back to any answer revealing the gap.
  const toGap = options.filter((o) => actualGaps.includes(o.reveals.points_to));
  const unnamed = toGap.filter((o) => o.reveals.misconception === undefined);
  const revealing = unnamed.length > 0 ? unnamed : toGap;
  const noise = options.filter((o) => o.reveals.misconception === undefined);
  const pool = revealing.length > 0 && random() < model.gapPick ? revealing : noise.length > 0 ? noise : options;
  return { response: pick(pool, random).response, certainty: random() < 0.5 ? 1 : 2 };
}

/** Default chance that an intervention clears the belief it targets, for a learner who holds it. A scenario parameter, not a finding. */
export const DEFAULT_EFFICACY: Readonly<Record<Template, number>> = { contrast: 0.6, practice: 0.5, step_through: 0.6 };

/** Each learner gets their own random stream, so changing one learner's path doesn't reshuffle everyone else's. */
const learnerSeed = (seed: number, learnerId: number) => (Math.imul(seed, 0x9e3779b1) ^ Math.imul(learnerId + 1, 0x85ebca77)) >>> 0;

/**
 * Simulates learners taking the course in an order the *published* graph allows.
 * Whether they master a lesson depends on the *true* course graph: a learner who reaches a lesson
 * without its real prerequisites can't master it, and their wrong answers tend to reveal that gap.
 *
 * With `retakes`, a learner who fails a quiz follows the per-learner router (src/path/route.ts): they
 * are shown the release's interventions for the misconceptions they showed, which clear a belief they
 * hold with the scenario's efficacy, then retake the quiz. Without an intervention, re-reading gives
 * them a small `relearn` chance. Fully deterministic for a given scenario, model and seed.
 */
export function simulate(
  course: Course,
  scenario: Scenario,
  {
    model = DEFAULT_LEARNER_MODEL,
    seed = scenario.seed,
    published = publishedGraph(course, scenario),
    interventions = [],
    retakes = false,
  }: {
    model?: LearnerModel;
    seed?: number;
    /** The graph learners are routed through; defaults to the course graph with the scenario's faults. */
    published?: PrereqGraph;
    /** Interventions in the release learners see. */
    interventions?: readonly LiveIntervention[];
    /** Let learners who fail retake the quiz once, after the router's remediation. */
    retakes?: boolean;
  } = {},
): Simulation {
  const takers = new Map<string, number>();
  const attempts: QuizAttempt[] = [];
  const optionsByItem = new Map(
    course.lessons.flatMap((lesson) => lesson.quiz.map((item) => [item.id, wrongOptions(item, lesson.id)] as const)),
  );
  const efficacy = (template: Template) => scenario.efficacy?.[template] ?? DEFAULT_EFFICACY[template];

  for (let learner_id = 0; learner_id < model.learners; learner_id++) {
    const random = seededRandom(learnerSeed(seed, learner_id));
    const learner: LearnerState = { mastered: new Set(), beliefs: new Map() };
    const { mastered } = learner;
    const gapsIn = (id: string) => (course.graph[id] ?? []).filter((prereq) => !mastered.has(prereq));
    const master = (id: string) => {
      mastered.add(id);
      learner.beliefs.set(id, null);
    };

    for (const lessonId of randomTopologicalOrder(published, random)) {
      const cap = scenario.takers?.[lessonId];
      const taken = takers.get(lessonId) ?? 0;
      if (cap !== undefined && taken >= cap) continue;
      takers.set(lessonId, taken + 1);

      const lesson = course.getLesson(lessonId)!;
      const takeQuiz = (masters: boolean, attempt: number, exposed: string[]): QuizAttempt => {
        const gaps = gapsIn(lessonId);
        const heldBeliefs = new Set(
          (masters ? [] : gaps.length > 0 ? gaps : [lessonId]).flatMap(
            (id) => beliefAbout(id, learner, course, scenario, model, random) ?? [],
          ),
        );
        const answered = lesson.quiz.map((item) =>
          answerItem(lessonId, item, masters, heldBeliefs, gaps, optionsByItem.get(item.id)!, model, random),
        );
        const record: QuizAttempt = {
          learner_id,
          lesson_id: lessonId,
          answers: answered.map((a) => a.response),
          certainty: answered.map((a) => a.certainty),
          attempt,
          exposed,
        };
        attempts.push(record);
        return record;
      };

      const masters = gapsIn(lessonId).length === 0 && random() < (scenario.mastery?.[lessonId] ?? model.baseMastery);
      if (masters) master(lessonId);
      const first = takeQuiz(masters, 1, []);
      if (!retakes) continue;

      const { grades, passed } = gradeAttempt(lesson, first);
      if (passed) continue;

      // Remediation, as the router decides it for this learner.
      const exposed: string[] = [];
      for (const step of nextSteps(lessonId, grades, passed, interventions)) {
        if (step.kind !== "intervention") continue;
        exposed.push(step.block_id);
        const shown = interventions.find((i) => i.block_id === step.block_id)!;
        const holds = learner.beliefs.get(shown.lesson) === step.misconception;
        // Clearing the belief that blocked a lesson lets the learner master it, if its prerequisites are in place.
        if (holds && random() < efficacy(shown.intervention.template) && gapsIn(shown.lesson).length === 0) master(shown.lesson);
      }
      if (!mastered.has(lessonId) && gapsIn(lessonId).length === 0 && random() < model.relearn) master(lessonId);
      takeQuiz(mastered.has(lessonId), 2, exposed);
    }
  }

  return { published, attempts };
}
