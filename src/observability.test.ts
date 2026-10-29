import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flushTraces, traceConfig, tracingEnabled } from "./observability.js";

describe("LangSmith tracing", () => {
  it("is off unless enabled and given a key", () => {
    assert.equal(tracingEnabled({}), false);
    assert.equal(tracingEnabled({ LANGSMITH_TRACING: "true" }), false);
    assert.equal(tracingEnabled({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "k" }), true);
  });

  it("labels a run so it can be found: name, tags and metadata", () => {
    assert.deepEqual(traceConfig({ name: "repair-run", thread_id: "t1", scenario: "missing-prereq", mode: "hitl", agents: false, release: "1.0.0" }), {
      runName: "repair-run",
      tags: ["hyperlearn", "scenario:missing-prereq", "mode:hitl", "agents:reference"],
      metadata: { thread_id: "t1", scenario: "missing-prereq", mode: "hitl", agents: false, release: "1.0.0" },
    });
    assert.deepEqual(traceConfig({ name: "demo" }), { runName: "demo", tags: ["hyperlearn"], metadata: {} });
  });

  it("flushes without error when tracing is off", async () => {
    await flushTraces();
  });
});
