import type { CourseRole } from "../app/access.js";
import type { Source, SourceRole } from "../course/sources.js";
import type { Sql } from "./sql.js";

// What a studio course object stores besides releases and learner events: its members, and the sources
// its owner uploaded. Same tagged-template SQLite as the rest (src/storage/sql.ts).

function createStudioTables(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS hl_members (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    name TEXT,
    email TEXT,
    joined_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS hl_sources (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    pages TEXT NOT NULL,
    chars INTEGER NOT NULL
  )`;
}

export interface Member {
  user_id: string;
  role: CourseRole;
  name: string | null;
  email: string | null;
  joined_at: string;
}

export class SqlMembers {
  constructor(private readonly sql: Sql) {
    createStudioTables(sql);
  }
  get(userId: string): Member | undefined {
    return this.sql<Member>`SELECT * FROM hl_members WHERE user_id = ${userId}`[0];
  }
  all(): Member[] {
    return this.sql<Member>`SELECT * FROM hl_members ORDER BY joined_at, user_id`;
  }
  /** Adds someone or changes their role; name and email are refreshed when given. */
  set(member: { user_id: string; role: CourseRole; name?: string | undefined; email?: string | undefined }, at: string) {
    this.sql`INSERT INTO hl_members (user_id, role, name, email, joined_at)
      VALUES (${member.user_id}, ${member.role}, ${member.name ?? null}, ${member.email ?? null}, ${at})
      ON CONFLICT (user_id) DO UPDATE SET
        role = excluded.role,
        name = COALESCE(excluded.name, hl_members.name),
        email = COALESCE(excluded.email, hl_members.email)`;
  }
  delete(userId: string) {
    this.sql`DELETE FROM hl_members WHERE user_id = ${userId}`;
  }
}

/** A source without its text, for lists. */
export interface SourceSummary {
  id: string;
  name: string;
  role: SourceRole | null;
  pages: number;
  chars: number;
}

export class SqlSources {
  constructor(private readonly sql: Sql) {
    createStudioTables(sql);
  }
  all(): Source[] {
    return this.sql<{ id: string; name: string; role: SourceRole | null; pages: string }>`SELECT id, name, role, pages FROM hl_sources ORDER BY seq`.map(
      (row) => ({ id: row.id, name: row.name, ...(row.role && { role: row.role }), pages: JSON.parse(row.pages) as string[] }),
    );
  }
  summaries(): SourceSummary[] {
    return this.sql<{ id: string; name: string; role: SourceRole | null; pages: string; chars: number }>`
      SELECT id, name, role, pages, chars FROM hl_sources ORDER BY seq`.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      pages: (JSON.parse(row.pages) as string[]).length,
      chars: row.chars,
    }));
  }
  get(id: string): Source | undefined {
    return this.all().find((s) => s.id === id);
  }
  count(): number {
    return (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM hl_sources`[0] as { n: number }).n;
  }
  totalChars(): number {
    return (this.sql<{ n: number }>`SELECT COALESCE(SUM(chars), 0) AS n FROM hl_sources`[0] as { n: number }).n;
  }
  /** The next free id: s1, s2, … (never reused within a course, so old citations can't point at a new file). */
  nextId(): string {
    const [row] = this.sql<{ n: number }>`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM hl_sources`;
    return `s${(row as { n: number }).n}`;
  }
  put(source: Source) {
    const chars = source.pages.reduce((sum, p) => sum + p.length, 0);
    const pages = JSON.stringify(source.pages);
    const seq = Number(source.id.slice(1));
    this.sql`INSERT INTO hl_sources (id, seq, name, role, pages, chars) VALUES (${source.id}, ${seq}, ${source.name}, ${source.role ?? null}, ${pages}, ${chars})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role, pages = excluded.pages, chars = excluded.chars`;
  }
  delete(id: string) {
    this.sql`DELETE FROM hl_sources WHERE id = ${id}`;
  }
}
