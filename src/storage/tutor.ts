import type { Sql } from "./sql.js";

// What the tutor ("Ask Muse") stores, beside the coach's state: the conversation per learner and lesson,
// the personal blocks it made, the images it generated, suggestions for editors, and per target and
// approach how often a personal lesson was shown and how often it fixed the learner (the bandit's counts).

/** One message of a tutor conversation. `summary` rows hold what was folded out of the window. */
export interface TutorTurnRow {
  seq: number;
  role: "user" | "assistant" | "summary";
  text: string;
  at: string;
}

export type PersonalKind = "rewrite" | "diagram" | "widget" | "storyboard";
export type PersonalStatus = "running" | "ready" | "failed";

/** A personal block as stored; `job` says what to make, `pieces` and `provenance` what was made (JSON). */
export interface PersonalRow {
  id: string;
  learner: string;
  lesson: string;
  section: string;
  kind: PersonalKind;
  status: PersonalStatus;
  job: string;
  pieces: string;
  provenance: string | null;
  approach: string | null;
  release: string;
  problems: string | null;
  at: string;
  live: number;
}

export interface ImageRow {
  id: string;
  learner: string;
  prompt_hash: string;
  mime: string;
  data: string;
  bytes: number;
  at: string;
}

export interface SuggestionRow {
  id: number;
  lesson: string;
  section: string;
  why: string;
  learner: string;
  approach: string | null;
  at: string;
}

/** Messages kept per learner and lesson (20 exchanges of question and answer); older ones are folded into the summary row. */
export const KEEP_TUTOR_MESSAGES = 80;
/** Longest summary row: it is a reminder for the model, not a transcript. */
const MAX_SUMMARY_CHARS = 1_200;

export class SqlTutor {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS hl_tutor_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner TEXT NOT NULL,
      lesson TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    )`;
    sql`CREATE INDEX IF NOT EXISTS hl_tutor_turns_learner ON hl_tutor_turns (learner, lesson, seq)`;
    sql`CREATE TABLE IF NOT EXISTS hl_personal_blocks (
      id TEXT PRIMARY KEY,
      learner TEXT NOT NULL,
      lesson TEXT NOT NULL,
      section TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      job TEXT NOT NULL,
      pieces TEXT NOT NULL,
      provenance TEXT,
      approach TEXT,
      release TEXT NOT NULL,
      problems TEXT,
      at TEXT NOT NULL,
      live INTEGER NOT NULL
    )`;
    // At most one live block per learner, section and kind; older ones stay, archived (live = 0).
    sql`CREATE UNIQUE INDEX IF NOT EXISTS hl_personal_live ON hl_personal_blocks (learner, section, kind) WHERE live = 1`;
    sql`CREATE INDEX IF NOT EXISTS hl_personal_learner ON hl_personal_blocks (learner, lesson, live)`;
    sql`CREATE INDEX IF NOT EXISTS hl_personal_status ON hl_personal_blocks (status, at)`;
    sql`CREATE TABLE IF NOT EXISTS hl_generated_images (
      id TEXT PRIMARY KEY,
      learner TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      at TEXT NOT NULL
    )`;
    sql`CREATE INDEX IF NOT EXISTS hl_generated_images_learner ON hl_generated_images (learner, at)`;
    sql`CREATE INDEX IF NOT EXISTS hl_generated_images_prompt ON hl_generated_images (prompt_hash)`;
    sql`CREATE TABLE IF NOT EXISTS hl_tutor_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson TEXT NOT NULL,
      section TEXT NOT NULL,
      why TEXT NOT NULL,
      learner TEXT NOT NULL,
      approach TEXT,
      at TEXT NOT NULL
    )`;
    sql`CREATE INDEX IF NOT EXISTS hl_tutor_suggestions_at ON hl_tutor_suggestions (at, id)`;
    // Kept current on write (a re-check or a tutor follow-up), so choosing an approach reads a few rows.
    sql`CREATE TABLE IF NOT EXISTS hl_coach_targets (
      target_key TEXT NOT NULL,
      approach TEXT NOT NULL,
      shown INTEGER NOT NULL,
      fixed INTEGER NOT NULL,
      PRIMARY KEY (target_key, approach)
    )`;
  }

  // ─── Conversation ─────────────────────────────────────────────────

  /** The summary row (if any) and the last `limit` messages, oldest first. */
  window(learner: string, lesson: string, limit: number): { summary: string | null; messages: TutorTurnRow[] } {
    const summary = this.sql<{ text: string }>`SELECT text FROM hl_tutor_turns WHERE learner = ${learner} AND lesson = ${lesson} AND role = 'summary' LIMIT 1`[0]?.text ?? null;
    const messages = this.sql<TutorTurnRow>`SELECT seq, role, text, at FROM hl_tutor_turns
      WHERE learner = ${learner} AND lesson = ${lesson} AND role != 'summary' ORDER BY seq DESC LIMIT ${limit}`.reverse();
    return { summary, messages };
  }

  /** Appends a message; beyond KEEP_TUTOR_MESSAGES the oldest are folded into the summary row and deleted. */
  append(learner: string, lesson: string, role: "user" | "assistant", text: string, at: string) {
    const last = this.sql<{ seq: number }>`SELECT MAX(seq) AS seq FROM hl_tutor_turns WHERE learner = ${learner} AND lesson = ${lesson}`[0]?.seq ?? 0;
    this.sql`INSERT INTO hl_tutor_turns (learner, lesson, seq, role, text, at) VALUES (${learner}, ${lesson}, ${(last ?? 0) + 1}, ${role}, ${text}, ${at})`;
    const count = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_tutor_turns WHERE learner = ${learner} AND lesson = ${lesson} AND role != 'summary'`[0]!.n;
    if (count <= KEEP_TUTOR_MESSAGES) return;
    const old = this.sql<TutorTurnRow>`SELECT seq, role, text, at FROM hl_tutor_turns
      WHERE learner = ${learner} AND lesson = ${lesson} AND role != 'summary' ORDER BY seq LIMIT ${count - KEEP_TUTOR_MESSAGES}`;
    const previous = this.window(learner, lesson, 0).summary ?? "";
    const folded = old.map((m) => `${m.role === "user" ? "Learner" : "Muse"}: ${m.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
    // Newest last; the oldest lines drop off the front once the summary is full.
    const summary = `${previous}\n${folded}`.trim().slice(-MAX_SUMMARY_CHARS);
    const upTo = old[old.length - 1]!.seq;
    this.sql`DELETE FROM hl_tutor_turns WHERE learner = ${learner} AND lesson = ${lesson} AND role != 'summary' AND seq <= ${upTo}`;
    this.sql`DELETE FROM hl_tutor_turns WHERE learner = ${learner} AND lesson = ${lesson} AND role = 'summary'`;
    this.sql`INSERT INTO hl_tutor_turns (learner, lesson, seq, role, text, at) VALUES (${learner}, ${lesson}, 0, 'summary', ${summary}, ${at})`;
  }

  // ─── Personal blocks ──────────────────────────────────────────────

  /** Adds a live block, archiving the learner's live block of the same kind on that section. */
  putPersonal(row: Omit<PersonalRow, "live">) {
    this.sql`UPDATE hl_personal_blocks SET live = 0 WHERE learner = ${row.learner} AND section = ${row.section} AND kind = ${row.kind} AND live = 1`;
    this.sql`INSERT INTO hl_personal_blocks (id, learner, lesson, section, kind, status, job, pieces, provenance, approach, release, problems, at, live)
      VALUES (${row.id}, ${row.learner}, ${row.lesson}, ${row.section}, ${row.kind}, ${row.status}, ${row.job}, ${row.pieces}, ${row.provenance}, ${row.approach}, ${row.release}, ${row.problems}, ${row.at}, 1)`;
  }

  personal(id: string): PersonalRow | undefined {
    return this.sql<PersonalRow>`SELECT * FROM hl_personal_blocks WHERE id = ${id}`[0];
  }

  /** A learner's live blocks on one lesson, in the order they were made. */
  livePersonal(learner: string, lesson: string): PersonalRow[] {
    return this.sql<PersonalRow>`SELECT * FROM hl_personal_blocks WHERE learner = ${learner} AND lesson = ${lesson} AND live = 1 ORDER BY at, id`;
  }

  /** Finishes a block; only a running one changes, so a late writer can't overwrite an undo or a newer block. */
  finishPersonal(id: string, patch: { status: "ready" | "failed"; pieces?: string; provenance?: string | null; approach?: string | null; problems?: string | null }) {
    const row = this.personal(id);
    if (!row || row.status !== "running") return false;
    this.sql`UPDATE hl_personal_blocks SET status = ${patch.status}, pieces = ${patch.pieces ?? row.pieces}, provenance = ${patch.provenance === undefined ? row.provenance : patch.provenance},
      approach = ${patch.approach === undefined ? row.approach : patch.approach}, problems = ${patch.problems ?? null} WHERE id = ${id}`;
    return true;
  }

  /** How many blocks of a kind this learner has had on a section (live or archived): the attempt number. */
  countPersonal(learner: string, section: string, kind: PersonalKind): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_personal_blocks WHERE learner = ${learner} AND section = ${section} AND kind = ${kind}`[0]!.n;
  }

  setJob(id: string, job: string) {
    this.sql`UPDATE hl_personal_blocks SET job = ${job} WHERE id = ${id}`;
  }

  /** Takes a learner's live block down (it stays, archived). */
  archivePersonal(learner: string, id: string): boolean {
    const row = this.personal(id);
    if (!row || row.learner !== learner || row.live !== 1) return false;
    this.sql`UPDATE hl_personal_blocks SET live = 0 WHERE id = ${id}`;
    return true;
  }

  /** Blocks still marked running: after a restart nothing is writing them, so they are marked failed. */
  failRunning(problem: string) {
    this.sql`UPDATE hl_personal_blocks SET status = 'failed', problems = ${JSON.stringify([problem])} WHERE status = 'running'`;
  }

  /** Whether `imageId` appears in one of the learner's live blocks (they may see it even if someone else made it). */
  showsImage(learner: string, imageId: string): boolean {
    // Pieces name images by id (an image piece's "id", a storyboard frame's "image"): an exact JSON string.
    const pattern = `%"${imageId.replace(/[%_"\\]/g, "")}"%`;
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_personal_blocks WHERE learner = ${learner} AND live = 1 AND pieces LIKE ${pattern}`[0]!.n > 0;
  }

  // ─── Generated images ─────────────────────────────────────────────

  image(id: string): ImageRow | undefined {
    return this.sql<ImageRow>`SELECT * FROM hl_generated_images WHERE id = ${id}`[0];
  }

  imageByPrompt(hash: string): ImageRow | undefined {
    return this.sql<ImageRow>`SELECT * FROM hl_generated_images WHERE prompt_hash = ${hash} LIMIT 1`[0];
  }

  /** Images this learner generated since `since` (cache hits are free and not counted). */
  imagesSince(learner: string, since: string): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_generated_images WHERE learner = ${learner} AND at >= ${since}`[0]!.n;
  }

  putImage(row: ImageRow) {
    this.sql`INSERT INTO hl_generated_images (id, learner, prompt_hash, mime, data, bytes, at)
      VALUES (${row.id}, ${row.learner}, ${row.prompt_hash}, ${row.mime}, ${row.data}, ${row.bytes}, ${row.at}) ON CONFLICT (id) DO NOTHING`;
  }

  // ─── Suggestions for editors ──────────────────────────────────────

  suggest(row: Omit<SuggestionRow, "id">) {
    this.sql`INSERT INTO hl_tutor_suggestions (lesson, section, why, learner, approach, at) VALUES (${row.lesson}, ${row.section}, ${row.why}, ${row.learner}, ${row.approach}, ${row.at})`;
  }

  /** The newest suggestions, newest first, at most `limit`. */
  suggestions(limit: number): SuggestionRow[] {
    return this.sql<SuggestionRow>`SELECT * FROM hl_tutor_suggestions ORDER BY at DESC, id DESC LIMIT ${limit}`;
  }

  // ─── Approach outcomes per target (the bandit's counts) ───────────

  countOutcome(targetKey: string, approach: string, fixed: boolean) {
    const add = fixed ? 1 : 0;
    this.sql`INSERT INTO hl_coach_targets (target_key, approach, shown, fixed) VALUES (${targetKey}, ${approach}, 1, ${add})
      ON CONFLICT (target_key, approach) DO UPDATE SET shown = shown + 1, fixed = fixed + ${add}`;
  }

  outcomes(targetKey: string): { approach: string; shown: number; fixed: number }[] {
    return this.sql<{ approach: string; shown: number; fixed: number }>`SELECT approach, shown, fixed FROM hl_coach_targets WHERE target_key = ${targetKey} ORDER BY approach`;
  }

  /** Every target's counts: one row per target and approach, which grows with the course's targets, not with learners. */
  allOutcomes(): { target_key: string; approach: string; shown: number; fixed: number }[] {
    return this.sql<{ target_key: string; approach: string; shown: number; fixed: number }>`SELECT * FROM hl_coach_targets ORDER BY target_key, approach`;
  }

  outcomesEmpty(): boolean {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_coach_targets`[0]!.n === 0;
  }

  /** Everything stored about one learner (their own data request). Shared counts and suggestions stay, without them. */
  deleteLearner(learner: string) {
    this.sql`DELETE FROM hl_tutor_turns WHERE learner = ${learner}`;
    this.sql`DELETE FROM hl_personal_blocks WHERE learner = ${learner}`;
    this.sql`DELETE FROM hl_generated_images WHERE learner = ${learner}`;
    this.sql`DELETE FROM hl_tutor_suggestions WHERE learner = ${learner}`;
  }
}
