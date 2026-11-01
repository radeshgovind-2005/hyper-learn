import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqlite } from "../node/sqlite.js";
import { KEEP_ARCHIVED_BLOCKS, KEEP_TUTOR_MESSAGES, SqlTutor } from "./tutor.js";

// The tutor's storage at volume: what grows with time stays bounded.

describe("tutor storage", () => {
  it("keeps a bounded conversation per learner and lesson, folding the oldest into one summary row", () => {
    const store = new SqlTutor(sqlite());
    const t0 = Date.now();
    for (let i = 0; i < 1_000; i++) store.append("bob", "l1", i % 2 === 0 ? "user" : "assistant", `message ${i}`, new Date(t0 + i).toISOString());
    store.append("eve", "l1", "user", "hello", new Date(t0).toISOString());
    const { summary, messages } = store.window("bob", "l1", 24);
    assert.equal(messages.length, 24);
    assert.equal(messages.at(-1)!.text, "message 999");
    assert.ok(summary && summary.length <= 1_200 && summary.includes("message 919"), "the newest folded messages are in the summary");
    assert.equal(store.window("bob", "l1", 10_000).messages.length, KEEP_TUTOR_MESSAGES);
    assert.equal(store.window("eve", "l1", 24).messages.length, 1, "per learner");
    assert.ok(Date.now() - t0 < 5_000);
  });

  it("keeps only the last few archived personal blocks per section, and drops old pictures no live block shows", () => {
    const store = new SqlTutor(sqlite());
    const put = (id: string, at: string, pieces = "[]") =>
      store.putPersonal({ id, learner: "bob", lesson: "l1", section: "l1/a", kind: "diagram", status: "ready", job: "{}", pieces, provenance: null, approach: null, release: "1.0.0", problems: null, at });
    for (let i = 0; i < 20; i++) put(`b${i}`, `2026-11-01T00:00:${String(i).padStart(2, "0")}Z`);
    assert.equal(store.countPersonal("bob", "l1/a", "diagram"), 1 + KEEP_ARCHIVED_BLOCKS);
    assert.deepEqual(store.livePersonal("bob", "l1").map((b) => b.id), ["b19"]);

    const image = (id: string, at: string) => store.putImage({ id, learner: "bob", prompt_hash: id, mime: "image/webp", data: "x", bytes: 1, at });
    image("aaaa", "2026-09-01T00:00:00Z");
    image("bbbb", "2026-09-01T00:00:00Z");
    image("cccc", "2026-10-31T00:00:00Z");
    put("b20", "2026-11-01T00:01:00Z", JSON.stringify([{ kind: "image", id: "bbbb", caption: "kept" }]));
    assert.equal(store.pruneImages("2026-10-01T00:00:00Z"), 1);
    assert.equal(store.image("aaaa"), undefined, "old and shown nowhere");
    assert.ok(store.image("bbbb"), "old but a live block shows it");
    assert.ok(store.image("cccc"), "recent");
  });
});
