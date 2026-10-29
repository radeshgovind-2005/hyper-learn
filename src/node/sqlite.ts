import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../storage/sql.js";

/** A `sql` tag over Node's built-in SQLite, shaped like a Cloudflare Agent's `this.sql`. For tests and local tools. */
export function sqlite(path = ":memory:"): Sql {
  const db = new DatabaseSync(path);
  return ((strings: TemplateStringsArray, ...values: (string | number | null)[]) => {
    const statement = db.prepare(strings.join("?"));
    if (/^\s*SELECT/i.test(strings[0]!)) return statement.all(...values);
    statement.run(...values);
    return [];
  }) as Sql;
}
