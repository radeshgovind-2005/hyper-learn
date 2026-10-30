import type { CourseSnapshot } from "../course/compile.js";
import { infoOf, initialRelease, type Release, type ReleaseInfo, type ReleaseStore } from "../releases/release.js";
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
  // Trials read every answer since they started, and owner insights read coach events: by kind, not learner.
  sql`CREATE INDEX IF NOT EXISTS hl_events_kind ON hl_events (kind, at)`;
  sql`CREATE TABLE IF NOT EXISTS hl_profiles (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    role TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`;
}

/** Releases, one JSON row each, in creation order. */
export class SqlReleaseStore implements ReleaseStore {
  /**
   * Snapshots are hundreds of KB of JSON, and every learner call needs the live one. So each row also
   * keeps `status` and `info` (the release without its snapshot) in their own columns, and the parsed
   * live release and the last few others stay in memory until a write changes them. Lists and history
   * read `info` only; a snapshot is parsed once per write, not once per call.
   */
  private liveCache: Release | undefined;
  private readonly recent = new Map<string, Release>();
  private static readonly RECENT = 4;

  /** Without `initial`, an empty store stays empty: a studio course has no release until it's published. */
  constructor(
    private readonly sql: Sql,
    initial: CourseSnapshot | undefined,
    now = () => new Date().toISOString(),
  ) {
    createTables(sql);
    this.addColumns();
    if (initial && this.count() === 0) this.add(initialRelease(initial, now()));
  }

  /** Objects created before `status`/`info` existed get the columns, filled once from their rows. */
  private addColumns() {
    const columns = this.sql<{ name: string }>`SELECT name FROM pragma_table_info('hl_releases')`.map((c) => c.name);
    if (!columns.includes("status")) this.sql`ALTER TABLE hl_releases ADD COLUMN status TEXT`;
    if (!columns.includes("info")) this.sql`ALTER TABLE hl_releases ADD COLUMN info TEXT`;
    for (const { version, data } of this.sql<{ version: string; data: string }>`SELECT version, data FROM hl_releases WHERE info IS NULL OR status IS NULL`) {
      const release = JSON.parse(data) as Release;
      this.sql`UPDATE hl_releases SET status = ${release.status}, info = ${JSON.stringify(infoOf(release))} WHERE version = ${version}`;
    }
    this.sql`CREATE INDEX IF NOT EXISTS hl_releases_status ON hl_releases (status)`;
  }

  private count(): number {
    return (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_releases`[0] as { n: number }).n;
  }

  private forget() {
    this.liveCache = undefined;
    this.recent.clear();
  }

  /** The first release (v1.0.0), if there is one. */
  first(): Release | undefined {
    const [row] = this.sql<{ version: string }>`SELECT version FROM hl_releases ORDER BY seq LIMIT 1`;
    return row ? this.get(row.version) : undefined;
  }

  live(): Release {
    if (!this.liveCache) {
      const [row] = this.sql<{ data: string }>`SELECT data FROM hl_releases WHERE status = 'live' ORDER BY seq DESC LIMIT 1`;
      if (!row) throw new Error("No live release");
      this.liveCache = JSON.parse(row.data) as Release;
    }
    return this.liveCache;
  }
  get(version: string) {
    if (this.liveCache?.version === version) return this.liveCache;
    const cached = this.recent.get(version);
    if (cached) return cached;
    const [row] = this.sql<{ data: string }>`SELECT data FROM hl_releases WHERE version = ${version}`;
    if (!row) return undefined;
    const release = JSON.parse(row.data) as Release;
    // A trial is read on every call of the learners in its arm; history views read a few old ones.
    this.recent.set(version, release);
    if (this.recent.size > SqlReleaseStore.RECENT) this.recent.delete(this.recent.keys().next().value!);
    return release;
  }
  all() {
    return this.sql<{ data: string }>`SELECT data FROM hl_releases ORDER BY seq`.map((row) => JSON.parse(row.data) as Release);
  }
  summaries() {
    return this.sql<{ info: string }>`SELECT info FROM hl_releases ORDER BY seq`.map((row) => JSON.parse(row.info) as ReleaseInfo);
  }
  add(release: Release) {
    if (this.sql`SELECT 1 FROM hl_releases WHERE version = ${release.version}`.length > 0) throw new Error(`Release ${release.version} already exists`);
    const [{ next }] = this.sql<{ next: number }>`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM hl_releases` as [{ next: number }];
    this.sql`INSERT INTO hl_releases (version, seq, data, status, info) VALUES (${release.version}, ${next}, ${JSON.stringify(release)}, ${release.status}, ${JSON.stringify(infoOf(release))})`;
    this.forget();
  }
  update(version: string, patch: Partial<Release>) {
    const release = this.get(version);
    if (!release) throw new Error(`No release ${version}`);
    const next = { ...structuredClone(release), ...structuredClone(patch) };
    this.sql`UPDATE hl_releases SET data = ${JSON.stringify(next)}, status = ${next.status}, info = ${JSON.stringify(infoOf(next))} WHERE version = ${version}`;
    this.forget();
    return next;
  }
  /** Removes every release: a course store starts over from `initial`. */
  reset(initial: CourseSnapshot, now = () => new Date().toISOString()) {
    this.sql`DELETE FROM hl_releases`;
    this.forget();
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
   * lesson: active time on a lesson · intervention: one was shown or completed · check: an answer to a
   * section's practice check (never scored) · coach: the study coach diagnosed, repaired or re-checked.
   */
  kind: "answer" | "path" | "session" | "lesson" | "intervention" | "check" | "coach";
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
  /** Every graded quiz since `since` (default: all), across learners, oldest first. */
  answers(since = ""): LearnerEvent[] {
    return this.sql<{ id: number; learner: string; kind: LearnerEvent["kind"]; lesson: string | null; release: string; data: string; at: string }>`
      SELECT * FROM hl_events WHERE kind = 'answer' AND at >= ${since} ORDER BY id`.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
  /** Every learner who has any event, with their latest activity. */
  /** Every event of one kind, oldest first (indexed: the coach's insights, not the whole log). */
  ofKind(kind: LearnerEvent["kind"]): LearnerEvent[] {
    return this.sql<LearnerEvent & { data: string }>`
      SELECT * FROM hl_events WHERE kind = ${kind} ORDER BY at, id`.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }

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

/** Who a learner is, as last seen in their verified session token: for instructors' views. */
export interface Profile {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  first_seen: string;
  last_seen: string;
}

/** One row of the instructors' list, kept current on write so the list never scans the event log. */
export interface LearnerState {
  needs_help: boolean;
  open_beliefs: { id: string; belief: string; lesson: string }[];
}

export class SqlProfiles {
  constructor(private readonly sql: Sql) {
    createTables(sql);
    sql`CREATE INDEX IF NOT EXISTS hl_profiles_seen ON hl_profiles (last_seen, user_id)`;
    // Updated when a learner submits a quiz: what the list filters and counts by.
    sql`CREATE TABLE IF NOT EXISTS hl_learner_state (
      user_id TEXT PRIMARY KEY,
      needs_help INTEGER NOT NULL,
      open_beliefs TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
  }
  /** Records a sign-in: creates the profile or refreshes its name, email, role and last-seen time. */
  seen(profile: { user_id: string; name?: string | undefined; email?: string | undefined; role: string }, at: string) {
    this.sql`INSERT INTO hl_profiles (user_id, name, email, role, first_seen, last_seen)
      VALUES (${profile.user_id}, ${profile.name ?? null}, ${profile.email ?? null}, ${profile.role}, ${at}, ${at})
      ON CONFLICT (user_id) DO UPDATE SET
        name = COALESCE(excluded.name, hl_profiles.name),
        email = COALESCE(excluded.email, hl_profiles.email),
        role = excluded.role,
        last_seen = excluded.last_seen`;
  }
  /** Marks activity (a quiz) without changing who they are; creates a bare profile if there is none. */
  touch(userId: string, at: string) {
    this.sql`INSERT INTO hl_profiles (user_id, name, email, role, first_seen, last_seen)
      VALUES (${userId}, NULL, NULL, 'learner', ${at}, ${at})
      ON CONFLICT (user_id) DO UPDATE SET last_seen = MAX(hl_profiles.last_seen, excluded.last_seen)`;
  }
  get(userId: string): Profile | undefined {
    return this.sql<Profile>`SELECT * FROM hl_profiles WHERE user_id = ${userId}`[0];
  }
  all(): Profile[] {
    return this.sql<Profile>`SELECT * FROM hl_profiles ORDER BY last_seen DESC`;
  }
  /**
   * One page of profiles, most recently active first, from a keyset cursor (the last row's last_seen
   * and user_id). `needsHelp` keeps only learners whose state says so.
   */
  page({ after, limit, needsHelp }: { after?: { last_seen: string; user_id: string }; limit: number; needsHelp: boolean }): (Profile & Partial<LearnerState>)[] {
    const seen = after?.last_seen ?? "\uffff";
    const id = after?.user_id ?? "\uffff";
    return this.sql<Profile & { needs_help: number | null; open_beliefs: string | null }>`
      SELECT p.*, s.needs_help, s.open_beliefs FROM hl_profiles p LEFT JOIN hl_learner_state s ON s.user_id = p.user_id
      WHERE (p.last_seen < ${seen} OR (p.last_seen = ${seen} AND p.user_id < ${id}))
        AND (${needsHelp ? 1 : 0} = 0 OR s.needs_help = 1)
      ORDER BY p.last_seen DESC, p.user_id DESC LIMIT ${limit}`.map((row) => ({
      ...row,
      needs_help: row.needs_help === 1,
      open_beliefs: row.open_beliefs ? (JSON.parse(row.open_beliefs) as LearnerState["open_beliefs"]) : [],
    }));
  }
  /** The list's headline numbers and most widespread beliefs, counted in SQL. */
  totals(activeSince: string): { learners: number; active: number; needs_help: number; common_beliefs: { id: string; belief: string; learners: number }[] } {
    const [row] = this.sql<{ learners: number; active: number; needs_help: number }>`
      SELECT COUNT(*) AS learners,
        SUM(CASE WHEN p.last_seen >= ${activeSince} THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN s.needs_help = 1 THEN 1 ELSE 0 END) AS needs_help
      FROM hl_profiles p LEFT JOIN hl_learner_state s ON s.user_id = p.user_id`;
    const common_beliefs = this.sql<{ id: string; belief: string; learners: number }>`
      SELECT json_extract(b.value, '$.id') AS id, json_extract(b.value, '$.belief') AS belief, COUNT(*) AS learners
      FROM hl_learner_state s, json_each(s.open_beliefs) b
      GROUP BY id ORDER BY learners DESC, id LIMIT 5`.map((r) => ({ id: r.id, belief: r.belief, learners: r.learners }));
    return { learners: row?.learners ?? 0, active: row?.active ?? 0, needs_help: row?.needs_help ?? 0, common_beliefs };
  }
  setState(userId: string, state: LearnerState, at: string) {
    this.sql`INSERT INTO hl_learner_state (user_id, needs_help, open_beliefs, updated_at)
      VALUES (${userId}, ${state.needs_help ? 1 : 0}, ${JSON.stringify(state.open_beliefs)}, ${at})
      ON CONFLICT (user_id) DO UPDATE SET needs_help = excluded.needs_help, open_beliefs = excluded.open_beliefs, updated_at = excluded.updated_at`;
  }
  delete(userId: string) {
    this.sql`DELETE FROM hl_profiles WHERE user_id = ${userId}`;
    this.sql`DELETE FROM hl_learner_state WHERE user_id = ${userId}`;
  }
  /** Every learner's state is about the course as it was: a reset clears them all. */
  clearStates() {
    this.sql`DELETE FROM hl_learner_state`;
  }
  /** Records a role change made in the app, so lists show it before the person next signs in. */
  setRole(userId: string, role: string) {
    this.sql`UPDATE hl_profiles SET role = ${role} WHERE user_id = ${userId}`;
  }
}
