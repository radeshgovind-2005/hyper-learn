import { computePerformance } from "../analytics/performance.js";
import { type CourseSnapshot, courseFromSnapshot, liveInterventions } from "../course/compile.js";
import type { Course } from "../course/schema.js";
import type { Release } from "../releases/release.js";
import type { QuizAttempt } from "../simulation/learners.js";
import type { NodePerformance } from "../state.js";
import type { LearnerEvent } from "../storage/sql.js";
import { compare, MIN_ARM_ATTEMPTS, type Measurement, outcome } from "./decide.js";
import { finalFailures, persistence, publishedGraphOf, trialTarget } from "./measure.js";

// Real learners instead of simulated ones: diagnosis from the event log, trials that split learners into
// two arms, and a measurer that waits until both arms have enough learners to conclude anything.

export type Arm = "control" | "treatment";

/** Which arm a learner is in for a trial: stable for that learner and trial, 50/50 across learners. */
export function armOf(userId: string, trialVersion: string): Arm {
  let h = 2166136261;
  for (const c of `${trialVersion}:${userId}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  // FNV's low bit is only the parity of the input's characters; a final mix spreads every bit into it.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 2 === 0 ? "control" : "treatment";
}

interface AnswerEventData {
  /** Absent on answers recorded before exams were drawn: the whole quiz, in order. */
  item_ids?: string[];
  responses: QuizAttempt["answers"];
  certainty: QuizAttempt["certainty"];
  attempt?: number;
}

/** Quiz answers from the event log as attempts, numbered per learner and lesson in the order they happened. */
export function attemptsFrom(events: readonly LearnerEvent[]): (QuizAttempt & { learner: string; release: string; at: string })[] {
  const ids = new Map<string, number>();
  const counts = new Map<string, number>();
  return events
    .filter((e) => e.kind === "answer" && e.lesson)
    .map((e) => {
      const d = e.data as AnswerEventData;
      if (!ids.has(e.learner)) ids.set(e.learner, ids.size);
      const key = `${e.learner}:${e.lesson}`;
      const attempt = d.attempt ?? (counts.get(key) ?? 0) + 1;
      counts.set(key, attempt);
      return {
        learner_id: ids.get(e.learner)!,
        learner: e.learner,
        lesson_id: e.lesson!,
        ...(d.item_ids && { item_ids: d.item_ids }),
        answers: d.responses,
        certainty: d.certainty,
        attempt,
        release: e.release,
        at: e.at,
      };
    });
}

/**
 * Real learners' data for diagnosing a release: their first attempts at each quiz while that release was
 * served to them, graded on it, with `covered` set for misconceptions a live intervention targets.
 * Few learners means `low_sample` everywhere, which keeps the agents from acting on noise.
 */
export function realPerformance(snapshot: CourseSnapshot, version: string, events: readonly LearnerEvent[]): NodePerformance[] {
  const course = courseFromSnapshot(snapshot);
  const attempts = attemptsFrom(events).filter((a) => a.release === version && a.attempt === 1);
  const covered = new Set(liveInterventions(snapshot).map((i) => i.intervention.targets));
  return computePerformance(course, publishedGraphOf(snapshot), attempts).map((node) => ({
    ...node,
    misconceptions: node.misconceptions.map((m) => ({ ...m, covered: covered.has(m.id) })),
  }));
}

/** A trial that can't conclude yet: how many learners each arm has, against how many it needs. */
export interface PendingMeasurement {
  pending: true;
  lesson: string;
  control: number;
  treatment: number;
  needed: number;
}

export const isPending = (m: Measurement | PendingMeasurement): m is PendingMeasurement => "pending" in m;

/**
 * Measures a real trial from the event log. Each arm is the answers given on its release since the trial
 * started (control: the live release; treatment: the trial's), graded on that release. Pending until both
 * arms reach MIN_ARM_ATTEMPTS learners on the measured outcome; then the same comparison as simulated trials.
 */
export function measureReal(live: Release, trial: Release, events: readonly LearnerEvent[], since: string): Measurement | PendingMeasurement {
  const change = trial.changes[0];
  if (!change) throw new Error(`Release ${trial.version} has no changes to measure`);
  const target = trialTarget(live.snapshot, change);
  const all = attemptsFrom(events.filter((e) => e.at >= since));
  const arm = (release: Release): { course: Course; attempts: QuizAttempt[] } => ({
    course: courseFromSnapshot(release.snapshot),
    attempts: all.filter((a) => a.release === release.version),
  });
  const control = arm(live);
  const treatment = arm(trial);

  const controlFails = finalFailures(control.course, control.attempts);
  const treatmentFails = finalFailures(treatment.course, treatment.attempts);
  const failRate = (id: string) => {
    const c = controlFails.get(id) ?? { attempts: 0, hits: 0 };
    const t = treatmentFails.get(id) ?? { attempts: 0, hits: 0 };
    return compare(id, "fail_rate", outcome(c.attempts, c.hits), outcome(t.attempts, t.hits));
  };

  const primary =
    target.metric === "misconception_rate"
      ? (() => {
          const m = target.misconception!;
          const c = persistence(control.course, control.attempts, target.lesson, m);
          const t = persistence(treatment.course, treatment.attempts, target.lesson, m);
          return compare(target.lesson, "misconception_rate", outcome(c.attempts, c.hits), outcome(t.attempts, t.hits), m);
        })()
      : failRate(target.lesson);

  if (primary.control.attempts < MIN_ARM_ATTEMPTS || primary.treatment.attempts < MIN_ARM_ATTEMPTS) {
    return { pending: true, lesson: target.lesson, control: primary.control.attempts, treatment: primary.treatment.attempts, needed: MIN_ARM_ATTEMPTS };
  }
  const lessons = new Set([...controlFails.keys(), ...treatmentFails.keys()]);
  const guardrails = [...lessons].filter((id) => target.metric === "misconception_rate" || id !== target.lesson).map(failRate);
  return { source: "learners", expectation: target.expectation, primary, guardrails };
}

/** Measures real trials from an event log. */
export class RealMeasurer {
  constructor(private readonly events: () => readonly LearnerEvent[]) {}

  async measure(live: Release, candidate: Release): Promise<Measurement | PendingMeasurement> {
    return measureReal(live, candidate, this.events(), candidate.trial_started_at ?? candidate.created_at);
  }
}
