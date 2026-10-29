import { z } from "zod";
import type { MisconceptionDef } from "../course/schema.js";
import type { LearnerEvent } from "../storage/sql.js";

// One learner's history, summarised from their events: sessions, time per lesson, quizzes, the beliefs
// they showed and whether those cleared, and the interventions they saw. Pure functions, no I/O.

/** What the browser may report about a learner's own activity. Everything else is recorded by the server. */
export const TrackEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("lesson"),
    lesson: z.string().min(1),
    /** Time the lesson was on screen in a visible tab since the last report; at most 10 minutes per report. */
    active_ms: z.number().int().min(0).max(10 * 60_000),
  }),
  z.strictObject({
    kind: z.literal("intervention"),
    event: z.enum(["shown", "completed"]),
    block_id: z.string().min(1),
    /** "path": the router showed it to this learner; "preview": they opened it from the lesson. */
    context: z.enum(["path", "preview"]),
  }),
]);
export type TrackEvent = z.infer<typeof TrackEventSchema>;

/** Connections closer together than this belong to one session (a refresh or reconnect isn't a new visit). */
export const SESSION_GAP_MS = 30 * 60_000;

interface AnswerData {
  items: { item_id: string; pilot: boolean; grade: { correct: boolean; needs_review?: boolean; errors: { misconception?: string }[] } }[];
  passed: boolean;
  score: number;
}
interface SessionData {
  event: "start" | "end";
  session: string;
  duration_ms?: number;
}

const time = (at: string) => Date.parse(at);

export interface SessionSummary {
  start: string;
  end: string;
  duration_ms: number;
  lessons: string[];
  quizzes: number;
}

/**
 * Visits, from connection start/end events and the activity in between. A connection that never ended
 * (still open, or the tab was killed) ends at its last activity.
 */
export function sessionsOf(events: readonly LearnerEvent[], gapMs = SESSION_GAP_MS): SessionSummary[] {
  const connections = new Map<string, { start: number; end: number }>();
  for (const e of events) {
    if (e.kind !== "session") continue;
    const d = e.data as SessionData;
    const c = connections.get(d.session) ?? { start: time(e.at), end: time(e.at) };
    if (d.event === "start") c.start = Math.min(c.start, time(e.at));
    c.end = Math.max(c.end, time(e.at));
    connections.set(d.session, c);
  }
  // Activity extends the connection it happened in (events carry the session they came from).
  for (const e of events) {
    const session = (e.data as { session?: string } | null)?.session;
    const c = session ? connections.get(session) : undefined;
    if (c && e.kind !== "session") c.end = Math.max(c.end, time(e.at));
  }

  const merged: { start: number; end: number }[] = [];
  for (const c of [...connections.values()].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && c.start - last.end < gapMs) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }

  return merged.map(({ start, end }) => {
    const inside = events.filter((e) => time(e.at) >= start && time(e.at) <= end);
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      duration_ms: end - start,
      lessons: [...new Set(inside.flatMap((e) => (e.kind === "lesson" && e.lesson ? [e.lesson] : [])))],
      quizzes: inside.filter((e) => e.kind === "answer").length,
    };
  });
}

/** Active time per lesson, from the browser's visible-time reports. */
export function timePerLesson(events: readonly LearnerEvent[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const e of events) {
    if (e.kind !== "lesson" || !e.lesson) continue;
    total[e.lesson] = (total[e.lesson] ?? 0) + ((e.data as { active_ms?: number }).active_ms ?? 0);
  }
  return total;
}

export interface QuizRecord {
  lesson: string;
  at: string;
  score: number;
  passed: boolean;
  release: string;
}

export const quizHistory = (events: readonly LearnerEvent[]): QuizRecord[] =>
  events
    .filter((e) => e.kind === "answer" && e.lesson)
    .map((e) => {
      const d = e.data as AnswerData;
      return { lesson: e.lesson!, at: e.at, score: d.score, passed: d.passed, release: e.release };
    })
    .reverse();

export interface BeliefRecord {
  id: string;
  belief: string;
  /** Lesson whose quiz showed it. */
  lesson: string;
  first_seen: string;
  last_seen: string;
  times: number;
  /** A later attempt at that lesson's quiz passed without showing it. */
  cleared: boolean;
}

/** Named misconceptions a learner's answers showed, and whether they've since cleared. */
export function beliefsOf(events: readonly LearnerEvent[], catalog: readonly MisconceptionDef[]): BeliefRecord[] {
  const answers = events.filter((e) => e.kind === "answer" && e.lesson);
  const records = new Map<string, BeliefRecord>();
  for (const e of answers) {
    const d = e.data as AnswerData;
    const shown = new Set(
      d.items.filter((i) => !i.pilot && !i.grade.needs_review).flatMap((i) => i.grade.errors.flatMap((err) => err.misconception ?? [])),
    );
    for (const id of shown) {
      const r = records.get(id);
      if (r) {
        r.last_seen = e.at;
        r.times++;
        r.cleared = false;
      } else {
        records.set(id, {
          id,
          belief: catalog.find((m) => m.id === id)?.belief ?? id,
          lesson: e.lesson!,
          first_seen: e.at,
          last_seen: e.at,
          times: 1,
          cleared: false,
        });
      }
    }
    // A pass in the lesson where a belief was shown, without showing it again, clears it.
    if (d.passed) for (const r of records.values()) if (r.lesson === e.lesson && !shown.has(r.id)) r.cleared = true;
  }
  return [...records.values()].sort((a, b) => Number(a.cleared) - Number(b.cleared) || b.last_seen.localeCompare(a.last_seen));
}

export interface InterventionRecord {
  block_id: string;
  first_shown: string;
  completed: boolean;
  context: "path" | "preview";
}

export function interventionsOf(events: readonly LearnerEvent[]): InterventionRecord[] {
  const records = new Map<string, InterventionRecord>();
  for (const e of events) {
    if (e.kind !== "intervention") continue;
    const d = e.data as { event: "shown" | "completed"; block_id: string; context: "path" | "preview" };
    const r = records.get(d.block_id) ?? { block_id: d.block_id, first_shown: e.at, completed: false, context: d.context };
    if (d.event === "completed") r.completed = true;
    if (d.context === "path") r.context = "path";
    records.set(d.block_id, r);
  }
  return [...records.values()];
}

export interface TimelineEntry {
  at: string;
  kind: LearnerEvent["kind"];
  lesson: string | null;
  text: string;
  /** For quizzes: passed or not. Lets the UI colour the entry. */
  outcome?: "pass" | "fail";
}

const mins = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** A learner's history as plain sentences, newest first. */
export function timelineOf(
  events: readonly LearnerEvent[],
  titleOf: (lesson: string) => string,
  beliefOf: (misconception: string) => string,
  limit = 100,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const e of events) {
    const lesson = e.lesson ? titleOf(e.lesson) : "";
    switch (e.kind) {
      case "session": {
        const d = e.data as SessionData;
        entries.push({ at: e.at, kind: e.kind, lesson: null, text: d.event === "start" ? "Opened HyperLearn" : `Left after ${mins(d.duration_ms ?? 0)}` });
        break;
      }
      case "lesson":
        entries.push({ at: e.at, kind: e.kind, lesson: e.lesson, text: `${mins((e.data as { active_ms: number }).active_ms)} reading ${lesson}` });
        break;
      case "answer": {
        const d = e.data as AnswerData;
        const shown = [...new Set(d.items.flatMap((i) => i.grade.errors.flatMap((err) => err.misconception ?? [])))];
        entries.push({
          at: e.at,
          kind: e.kind,
          lesson: e.lesson,
          text: `Quiz on ${lesson}: ${Math.round(d.score * 100)}%${d.passed ? ", passed" : ", not passed"}${shown.length ? `, showing “${shown.map(beliefOf).join("”, “")}”` : ""}`,
          outcome: d.passed ? "pass" : "fail",
        });
        break;
      }
      case "intervention": {
        const d = e.data as { event: "shown" | "completed"; misconception?: string; context: string };
        const belief = d.misconception ? `“${beliefOf(d.misconception)}”` : "a misconception";
        entries.push({ at: e.at, kind: e.kind, lesson: e.lesson, text: `${d.event === "shown" ? "Was shown" : "Completed"} help for ${belief}${d.context === "preview" ? " (opened it)" : ""}` });
        break;
      }
      case "path":
        break; // the interventions it led to are recorded on their own
    }
  }
  return entries.reverse().slice(0, limit);
}
