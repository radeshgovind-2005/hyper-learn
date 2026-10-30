import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseSnapshot } from "../course/bundle.js";
import { sqlite } from "../node/sqlite.js";
import { initialRelease } from "../releases/release.js";
import { SqlReleaseStore } from "./sql.js";

describe("SqlReleaseStore", () => {
  it("adds status and info columns to a table created before them, filled from the rows", () => {
    const sql = sqlite();
    sql`CREATE TABLE hl_releases (version TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)`;
    const old = initialRelease(baseSnapshot(), "2026-10-01T00:00:00.000Z");
    sql`INSERT INTO hl_releases (version, seq, data) VALUES (${old.version}, 1, ${JSON.stringify(old)})`;
    const store = new SqlReleaseStore(sql, undefined);
    assert.equal(store.live().version, old.version);
    assert.deepEqual(sql<{ status: string }>`SELECT status FROM hl_releases`.map((r) => r.status), ["live"]);
    assert.equal("snapshot" in store.summaries()[0]!, false, "summaries carry no content");
  });

  it("parses the live release once per write, not once per call", () => {
    const sql = sqlite();
    const store = new SqlReleaseStore(sql, baseSnapshot());
    const first = store.live();
    assert.equal(store.live(), first, "the same parsed object until something is written");
    const next = { ...structuredClone(first), version: "1.1.0", parent: first.version, snapshot: { ...first.snapshot, version: "1.1.0" } };
    store.update(first.version, { status: "superseded" });
    store.add(next);
    assert.equal(store.live().version, "1.1.0");
    assert.equal(store.get("1.0.0")!.status, "superseded", "a cached copy doesn't survive a write");
    assert.deepEqual(store.summaries().map((r) => [r.version, r.status]), [["1.0.0", "superseded"], ["1.1.0", "live"]]);
  });
});
