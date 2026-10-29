import type { Mutation } from "../state.js";

/** The fix a scenario's planted fault calls for. `node_id: null` accepts any lesson (used by the control). */
export interface ExpectedMutation {
  action: Mutation["action"];
  node_id: string | null;
  target_node_id: string | null;
  misconception_id: string | null;
}

export interface Scenario {
  id: string;
  title: string;
  /** What was planted and why the expected fix is right. */
  description: string;
  seed: number;
  /** Faults in the published graph: [lesson, prerequisite] edges that learners are not made to follow. */
  removeEdges?: ReadonlyArray<readonly [lesson: string, prerequisite: string]>;
  /** Per-lesson chance of mastering it when all prerequisites are mastered (default: the learner model's). */
  mastery?: Readonly<Record<string, number>>;
  /** Relative weight of each misconception among learners who haven't mastered its lesson (default 1). */
  prevalence?: Readonly<Record<string, number>>;
  /** Cap on how many learners reach a lesson, to create low-sample data. */
  takers?: Readonly<Record<string, number>>;
  expected: ExpectedMutation;
}

const MISSING_TOOL_CALLING_EDGE = [["multi-agent", "tool-calling"]] as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "control",
    title: "Control — nothing planted",
    description: "The published graph matches the course. Only normal noise, so no lesson needs restructuring.",
    seed: 101,
    expected: { action: "flag_for_review", node_id: null, target_node_id: null, misconception_id: null },
  },
  {
    id: "missing-prereq",
    title: "Missing prerequisite — tool-calling → multi-agent",
    description:
      "The published graph lets learners start multi-agent before tool-calling. Those learners fail multi-agent and pick the wrong answers that reveal a tool-calling gap.",
    seed: 202,
    removeEdges: MISSING_TOOL_CALLING_EDGE,
    expected: { action: "add_prerequisite", node_id: "multi-agent", target_node_id: "tool-calling", misconception_id: null },
  },
  {
    id: "overloaded",
    title: "Overloaded lesson — agent-loop",
    description:
      "agent-loop is too hard: few learners master it. It fails with mistakes inside itself, and its dependents fail with mistakes pointing back at it, so the highest fail rate is not necessarily the root cause.",
    seed: 303,
    mastery: { "agent-loop": 0.4 },
    expected: { action: "split_node", node_id: "agent-loop", target_node_id: null, misconception_id: null },
  },
  {
    id: "dominant-misconception",
    title: "Dominant misconception — the model runs the actions",
    description:
      "Most learners who don't master agent-loop believe the model carries out its own actions. The lesson fails with one " +
      "confidently held belief rather than diffuse mistakes, so a targeted intervention fits better than a split.",
    seed: 505,
    mastery: { "agent-loop": 0.5 },
    prevalence: { "model-executes-actions": 8 },
    expected: {
      action: "add_intervention",
      node_id: "agent-loop",
      target_node_id: null,
      misconception_id: "model-executes-actions",
    },
  },
  {
    id: "low-sample-trap",
    title: "Low-sample trap — missing prerequisite plus a noisy outlier",
    description:
      "Same fault as missing-prereq, but only 10 learners reached reflection and most of them failed. Its fail rate is the highest yet unreliable; the right fix is still the missing prerequisite.",
    seed: 404,
    removeEdges: MISSING_TOOL_CALLING_EDGE,
    mastery: { reflection: 0.2 },
    takers: { reflection: 10 },
    expected: { action: "add_prerequisite", node_id: "multi-agent", target_node_id: "tool-calling", misconception_id: null },
  },
];

export function getScenario(id: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario "${id}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  return scenario;
}
