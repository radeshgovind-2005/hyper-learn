import exemplarsFile from "../../content/agentic-coding/exemplars.json" with { type: "json" };
import { type Intervention, InterventionSchema, type Template } from "./templates.js";

/**
 * Hand-written interventions: examples of good work for the Author agent, and what the rule-based
 * reference run releases (it can diagnose, but it can't write). They pass the same checks as agent-written ones.
 */
export const EXEMPLARS: readonly Intervention[] = InterventionSchema.array().parse(exemplarsFile);

export const exemplarFor = (misconception: string, templates: readonly Template[], exemplars: readonly Intervention[] = EXEMPLARS) =>
  exemplars.find((e) => e.targets === misconception && templates.includes(e.template));
