import type { CourseSnapshot } from "../course/compile.js";
import { initialRelease, type Release, type ReleaseStore } from "../releases/release.js";
import type { ThreadStore } from "./checkpointer.js";

// Storage on SQLite through a tagged template, the shape of a Cloudflare Agent's `this.sql`. Every
// query is parameterized by the tag. Tests run the same code on Node's built-in SQLite.

export type SqlValue = string | number | boolean | null;
export type Sql = <T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]) => T[];

export function createTables(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS hl_releases (version TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)`;
  sql`CREATE TABLE IF NOT EXISTS hl_threads (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  sql`CREATE TABLE IF NOT EXISTS hl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  sql`CREATE TABLE IF NOT EXISTS hl_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    learner TEXT NOT NULL,
    kind TEXT NOT NULL,
    lesson TEXT,
    release TEXT NOT NULL,
    data TEXT NOT NULL,
    at TEXT NOT NULL
  )`;
  sql`CREATE INDEX IF NOT EXISTS hl_events_learner ON hl_events (learner, kind)`;
}

/** Releases, one JSON row each, in creation order. */
export class SqlReleaseStore implements ReleaseStore {
  constructor(
    private readonly sql: Sql,
    initial: CourseSnapshot,
    now = () => new Date().toISOString(),
  ) {
    createTables(sql);
    if (this.all().length === 0) this.add(initialRelease(initial, now()));
  }

  live(): Release {
    const live = this.all().find((r) => r.status === "live");
    if (!live) throw new Error("No live release");
    return live;
  }
  get(version: string) {
    const [row] = this.sql<{ data: string }>`SELECT data FROM hl_releases WHERE version = ${version}`;
    return row ? (JSON.parse(row.data) as Release) : undefined;
  }
  all() {
    return this.sql<{ data: string }>`SELECT data FROM hl_releases ORDER BY seq`.map((row) => JSON.parse(row.data) as Release);
  }
  add(release: Release) {
    if (this.get(release.version)) throw new Error(`Release ${release.version} already exists`);
    const [{ next }] = this.sql<{ next: number }>`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM hl_releases` as [{ next: number }];
    this.sql`INSERT INTO hl_releases (version, seq, data) VALUES (${release.version}, ${next}, ${JSON.stringify(release)})`;
  }
  update(version: string, patch: Partial<Release>) {
    const release = this.get(version);
    if (!release) throw new Error(`No release ${version}`);
    const next = { ...release, ...structuredClone(patch) };
    this.sql`UPDATE hl_releases SET data = ${JSON.stringify(next)} WHERE version = ${version}`;
    return next;
  }
  /** Removes every release: a course store starts over from `initial`. */
  reset(initial: CourseSnapshot, now = () => new Date().toISOString()) {
    this.sql`DELETE FROM hl_releases`;
    this.add(initialRelease(initial, now()));
  }
}

/** LangGraph checkpoint threads, for PersistentMemorySaver. */
export class SqlThreadStore implements ThreadStore {
  constructor(private readonly sql: Sql) {
    createTables(sql);
  }
  get(id: string) {
    return this.sql<{ data: string }>`SELECT data FROM hl_threads WHERE id = ${id}`[0]?.data;
  }
  set(id: string, json: string) {
    this.sql`INSERT INTO hl_threads (id, data) VALUES (${id}, ${json}) ON CONFLICT (id) DO UPDATE SET data = excluded.data`;
  }
  delete(id: string) {
    this.sql`DELETE FROM hl_threads WHERE id = ${id}`;
  }
}

/** Something a learner did, pinned to the release they saw: the record trials and analytics are built from. */
export interface LearnerEvent {
  id?: number;
  learner: string;
  /**
   * answer: a graded quiz · path: the steps the router gave · session: a connection started or ended ·
   * lesson: active time on a lesson · intervention: one was shown or completed.
   */
  kind: "answer" | "path" | "session" | "lesson" | "intervention";
  lesson: string | null;
  release: string;
  data: unknown;
  at: string;
}

/** The append-only event log. */
export class SqlEventLog {
  constructor(private readonly sql: Sql) {
    createTables(sql);
  }
  append(event: Omit<LearnerEvent, "id">) {
    this.sql`INSERT INTO hl_events (learner, kind, lesson, release, data, at)
      VALUES (${event.learner}, ${event.kind}, ${event.lesson}, ${event.release}, ${JSON.stringify(event.data)}, ${event.at})`;
  }
  forLearner(learner: string): LearnerEvent[] {
    return this.sql<{ id: number; learner: string; kind: LearnerEvent["kind"]; lesson: string | null; release: string; data: string; at: string }>`
      SELECT * FROM hl_events WHERE learner = ${learner} ORDER BY id`.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
  /** Every learner who has any event, with their latest activity. */
  learners(): { learner: string; last_at: string }[] {
    return this.sql<{ learner: string; last_at: string }>`SELECT learner, MAX(at) AS last_at FROM hl_events GROUP BY learner ORDER BY last_at DESC`;
  }
  /** Removes one learner's history; returns how many events were deleted. */
  deleteLearner(learner: string): number {
    const [{ n }] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_events WHERE learner = ${learner}` as [{ n: number }];
    this.sql`DELETE FROM hl_events WHERE learner = ${learner}`;
    return n;
  }
  clear() {
    this.sql`DELETE FROM hl_events`;
  }
}

/** Small named JSON values (the current scenario, the current run). */
export class SqlMeta {
  constructor(private readonly sql: Sql) {
    createTables(sql);
  }
  get<T>(key: string): T | undefined {
    const row = this.sql<{ value: string }>`SELECT value FROM hl_meta WHERE key = ${key}`[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.sql`INSERT INTO hl_meta (key, value) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  }
}
