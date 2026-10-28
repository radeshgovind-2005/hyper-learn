import { z } from "zod";
import agentsFile from "./config/agents.json" with { type: "json" };
import { MODEL_TYPES } from "./models.js";
import { TOOL_NAMES, TOOL_REGISTRY } from "./tools/index.js";

// ─── Schema for src/config/agents.json ─────────────────────────────
// Strict objects reject unknown keys, so a typo in the JSON fails at startup instead of being ignored.

export const AGENT_NAMES = ["assistant", "curator", "reflection"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const lines = z.array(z.string()).default([]);

export const AgentDefinitionSchema = z.strictObject({
  /** Human-readable name. */
  name: z.string(),
  /** Which model profile from models.ts the agent runs on. */
  model: z.enum(MODEL_TYPES),
  /** Who the agent is; opens the system prompt. */
  role: z.string(),
  /** What the agent is trying to achieve. */
  goal: z.string(),
  /** Background added after the shared context. */
  context: lines,
  /** How to do the job. */
  instructions: lines,
  /** Numbered checks the agent must run (e.g. a reviewer's checklist). */
  checks: z.array(z.strictObject({ name: z.string(), rule: z.string() })).default([]),
  /** Hard rules the agent must not break. */
  constraints: lines,
  /** How to shape the answer. */
  output_format: z.string().optional(),
  /** Tools the agent may call, by name in TOOL_REGISTRY. */
  tools: z.array(z.enum(TOOL_NAMES)).default([]),
  /** Extra prompts with `{placeholder}` slots, rendered by renderTemplate(). */
  templates: z.record(z.string(), z.string()).default({}),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentsFileSchema = z.strictObject({
  /** Context given to every agent. */
  shared: z.strictObject({ context: lines }),
  agents: z.record(z.enum(AGENT_NAMES), AgentDefinitionSchema),
});
export type AgentsFile = z.infer<typeof AgentsFileSchema>;

const AGENTS: AgentsFile = AgentsFileSchema.parse(agentsFile);

// ─── Accessors ─────────────────────────────────────────────────────

export function getAgent(name: AgentName): AgentDefinition {
  return AGENTS.agents[name];
}

/** The LangChain tools an agent is allowed to call. */
export function getAgentTools(name: AgentName) {
  return getAgent(name).tools.map((toolName) => TOOL_REGISTRY[toolName]);
}

// ─── Prompt assembly ───────────────────────────────────────────────

const bulletSection = (title: string, items: string[]) =>
  items.length > 0 ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}` : undefined;

const numberedSection = (title: string, items: string[]) =>
  items.length > 0 ? `${title}:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}` : undefined;

/** Assembles an agent's system prompt from its definition, section by section. */
export function buildSystemPrompt(agent: AgentDefinition, shared: AgentsFile["shared"] = AGENTS.shared): string {
  return [
    agent.role,
    `Goal: ${agent.goal}`,
    bulletSection("Context", [...shared.context, ...agent.context]),
    bulletSection("Instructions", agent.instructions),
    numberedSection("Checks", agent.checks.map((check) => `${check.name}: ${check.rule}`)),
    bulletSection("Constraints", agent.constraints),
    agent.output_format && `Output format: ${agent.output_format}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The system prompt for a configured agent. */
export function getSystemPrompt(name: AgentName): string {
  return buildSystemPrompt(getAgent(name));
}

/** Renders one of an agent's templates, filling every `{placeholder}` from `vars`. */
export function renderTemplate(name: AgentName, template: string, vars: Record<string, string>): string {
  const text = getAgent(name).templates[template];
  if (text === undefined) throw new Error(`Agent "${name}" has no template "${template}"`);

  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Template "${name}.${template}" needs a value for {${key}}`);
    return value;
  });
}
