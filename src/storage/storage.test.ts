import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { baseSnapshot } from "../course/bundle.js";
import { planRelease, promote } from "../releases/release.js";
import { MemoryThreadStore, PersistentMemorySaver } from "./checkpointer.js";
import { sqlite } from "../node/sqlite.js";
import { SqlEventLog, SqlReleaseStore, SqlThreadStore } from "./sql.js";

describe("SqlReleaseStore", () => {
  it("starts from the initial release once, and keeps releases across instances", () => {
    const sql = sqlite();
    const store = new SqlReleaseStore(sql, baseSnapshot());
    assert.equal(store.live().version, "1.0.0");

    const plan = planRelease(store, [{ op: "add_prerequisite", lesson: "reflection", prerequisite: "llm-basics" }], "why");
    assert.ok(plan.ok);
    store.add(plan.candidate);
    promote(store, plan.candidate.version);

    const reopened = new SqlReleaseStore(sql, baseSnapshot());
    assert.deepEqual(reopened.all().map((r) => [r.version, r.status]), [
      ["1.0.0", "superseded"],
      ["2.0.0-trial.1", "promoted"],
      ["2.0.0", "live"],
    ]);
    assert.deepEqual(reopened.live().snapshot.lessons.find((l) => l.id === "reflection")?.prerequisites, ["multi-agent", "llm-basics"]);
  });

  it("resets to a fresh initial release", () => {
    const sql = sqlite();
    const store = new SqlReleaseStore(sql, baseSnapshot());
    store.add({ ...store.live(), version: "9.9.9", status: "reverted" });
    store.reset(baseSnapshot());
    assert.deepEqual(store.all().map((r) => r.version), ["1.0.0"]);
  });
});

describe("PersistentMemorySaver", () => {
  const State = Annotation.Root({ answer: Annotation<string | undefined>() });
  const build = (saver: PersistentMemorySaver) =>
    new StateGraph(State)
      .addNode("ask", () => ({ answer: interrupt<string, string>("approve?") }))
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: saver });

  for (const [name, threads] of [
    ["in memory", () => new MemoryThreadStore()],
    ["on SQLite", () => new SqlThreadStore(sqlite())],
  ] as const) {
    it(`resumes an interrupted run from a fresh saver (${name}), as after an eviction`, async () => {
      const store = threads();
      const config = { configurable: { thread_id: "run-1" } };
      await build(new PersistentMemorySaver(store)).invoke({}, config);

      const restarted = build(new PersistentMemorySaver(store));
      const pending = (await restarted.getState(config)).tasks.flatMap((t) => t.interrupts);
      assert.equal(pending[0]?.value, "approve?");
      const result = await restarted.invoke(new Command({ resume: "yes" }), config);
      assert.equal(result.answer, "yes");
    });
  }
});

describe("SqlEventLog", () => {
  it("appends events pinned to a release and reads one learner's history in order", () => {
    const log = new SqlEventLog(sqlite());
    log.append({ learner: "ada", kind: "answer", lesson: "agent-loop", release: "1.0.0", data: { passed: false }, at: "t1" });
    log.append({ learner: "bob", kind: "answer", lesson: "agent-loop", release: "1.0.0", data: { passed: true }, at: "t2" });
    log.append({ learner: "ada", kind: "path", lesson: "agent-loop", release: "1.1.0", data: { steps: [] }, at: "t3" });
    assert.deepEqual(log.forLearner("ada").map((e) => [e.kind, e.release, e.data]), [
      ["answer", "1.0.0", { passed: false }],
      ["path", "1.1.0", { steps: [] }],
    ]);
  });
});
