import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_NAMES,
  type AgentDefinition,
  AgentDefinitionSchema,
  AgentsFileSchema,
  buildSystemPrompt,
  getAgent,
  getAgentTools,
  getSystemPrompt,
  renderTemplate,
} from "./agents.js";
import agentsFile from "./config/agents.json" with { type: "json" };

const minimalAgent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition =>
  AgentDefinitionSchema.parse({ name: "Test", model: "fast", role: "You are a test.", goal: "Pass.", ...overrides });

describe("agents.json", () => {
  for (const name of AGENT_NAMES) {
    it(`builds a system prompt for "${name}" from its role, goal and the shared context`, () => {
      const agent = getAgent(name);
      const prompt = getSystemPrompt(name);
      assert.ok(prompt.startsWith(agent.role));
      assert.ok(prompt.includes(`Goal: ${agent.goal}`));
      for (const line of agentsFile.shared.context) assert.ok(prompt.includes(`- ${line}`));
    });
  }

  it("gives the assistant exactly the tools listed in its config", () => {
    const toolNames = getAgentTools("assistant").map((tool) => tool.name);
    assert.deepEqual(toolNames, getAgent("assistant").tools);
  });

  it("rejects a misspelled field instead of ignoring it", () => {
    const broken = structuredClone(agentsFile) as Record<string, any>;
    broken.agents.curator.instuctions = ["typo"];
    assert.equal(AgentsFileSchema.safeParse(broken).success, false);
  });

  it("rejects a tool that is not in the registry", () => {
    const broken = structuredClone(agentsFile) as Record<string, any>;
    broken.agents.assistant.tools.push("delete_everything");
    assert.equal(AgentsFileSchema.safeParse(broken).success, false);
  });

  it("rejects a missing agent", () => {
    const broken = structuredClone(agentsFile) as Record<string, any>;
    delete broken.agents.reflection;
    assert.equal(AgentsFileSchema.safeParse(broken).success, false);
  });
});

describe("buildSystemPrompt", () => {
  it("omits sections the agent doesn't define", () => {
    const prompt = buildSystemPrompt(minimalAgent(), { context: [] });
    assert.equal(prompt, "You are a test.\n\nGoal: Pass.");
  });

  it("numbers checks in order and appends the output format last", () => {
    const prompt = buildSystemPrompt(
      minimalAgent({
        checks: [
          { name: "FIRST", rule: "a" },
          { name: "SECOND", rule: "b" },
        ],
        output_format: "One line.",
      }),
      { context: [] },
    );
    assert.ok(prompt.includes("Checks:\n1. FIRST: a\n2. SECOND: b"));
    assert.ok(prompt.endsWith("Output format: One line."));
  });
});

describe("renderTemplate", () => {
  it("fills every placeholder", () => {
    const text = renderTemplate("curator", "retry", { mutation: "{...}", critique: "FIX: target n1" });
    assert.ok(text.includes("Rejected proposal: {...}"));
    assert.ok(text.includes("Reviewer critique: FIX: target n1"));
  });

  it("throws when a placeholder has no value", () => {
    assert.throws(() => renderTemplate("curator", "retry", { mutation: "{...}" }), /needs a value for \{critique\}/);
  });

  it("throws for an unknown template", () => {
    assert.throws(() => renderTemplate("assistant", "retry", {}), /has no template "retry"/);
  });
});
