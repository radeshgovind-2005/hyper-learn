import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logNode } from "../utils/logger.js";

// ─── Mock hypergraph (replace with the real store later) ───────────

interface HyperNode {
  id: string;
  title: string;
  kind: "doc" | "exercise";
  prerequisites: string[];
}

const MOCK_HYPERGRAPH: HyperNode[] = [
  { id: "n0", title: "Variables & Scope", kind: "doc", prerequisites: [] },
  { id: "n1", title: "Functions", kind: "doc", prerequisites: ["n0"] },
  { id: "n2", title: "Closures", kind: "doc", prerequisites: ["n0", "n1"] },
  { id: "n3", title: "Closures Exercise: Counter Factory", kind: "exercise", prerequisites: ["n2"] },
  { id: "n4", title: "Higher-Order Functions", kind: "doc", prerequisites: ["n1", "n2"] },
  { id: "n5", title: "Recursion", kind: "doc", prerequisites: ["n1"] },
];

const findNode = (id: string) => MOCK_HYPERGRAPH.find((node) => node.id === id);
const dependentsOf = (id: string) =>
  MOCK_HYPERGRAPH.filter((node) => node.prerequisites.includes(id)).map((node) => node.id);

// Tool results go back into a small (4k) context window, so keep them compact.
const toJson = (value: unknown) => JSON.stringify(value);

// ─── Tools ─────────────────────────────────────────────────────────

export const queryHypergraph = tool(
  async ({ node_id, topic }) => {
    logNode("tools", "query_hypergraph", { node_id, topic });
    const needle = topic?.toLowerCase();
    const matches = MOCK_HYPERGRAPH.filter(
      (node) => node.id === node_id || (needle !== undefined && node.title.toLowerCase().includes(needle)),
    );
    if (matches.length === 0) {
      return toJson({ error: "No matching node", available: MOCK_HYPERGRAPH.map(({ id, title }) => ({ id, title })) });
    }
    return toJson(
      matches.map((node) => ({
        ...node,
        prerequisites: node.prerequisites.map((id) => ({ id, title: findNode(id)?.title })),
        dependents: dependentsOf(node.id),
      })),
    );
  },
  {
    name: "query_hypergraph",
    description:
      "Look up concepts in the learning hypergraph by node id or topic keyword. Returns each node with its prerequisites and dependents.",
    schema: z.object({
      node_id: z.string().optional().describe("Exact node id, e.g. 'n2'"),
      topic: z.string().optional().describe("Keyword to search node titles, e.g. 'closures'"),
    }),
  },
);

export const generateDiagram = tool(
  async ({ node_ids, kind }) => {
    logNode("tools", "generate_diagram", { node_ids, kind });
    const nodes = node_ids.map(findNode).filter((node): node is HyperNode => node !== undefined);
    const ids = new Set(nodes.map((node) => node.id));
    const lines = nodes.flatMap((node) => [
      `  ${node.id}["${node.title}"]`,
      ...node.prerequisites
        .filter((pre) => kind === "concept_map" || ids.has(pre))
        .map((pre) => `  ${pre} --> ${node.id}`),
    ]);
    return toJson({ format: "mermaid", diagram: ["graph TD", ...lines].join("\n") });
  },
  {
    name: "generate_diagram",
    description:
      "Generate a Mermaid diagram of the given nodes. 'prerequisite_map' shows only edges among the given nodes; 'concept_map' also shows edges to outside prerequisites.",
    schema: z.object({
      node_ids: z.array(z.string()).min(1).describe("Node ids to include"),
      kind: z.enum(["prerequisite_map", "concept_map"]).default("prerequisite_map"),
    }),
  },
);

export const navigateUi = tool(
  async ({ target, node_id }) => {
    logNode("tools", "navigate_ui", { target, node_id });
    const path = target === "dashboard" ? "/dashboard" : `/${target}/${node_id ?? ""}`;
    return toJson({ action: "navigate", path, status: "queued" });
  },
  {
    name: "navigate_ui",
    description: "Navigate the learner's UI to a node page, an exercise, or their dashboard.",
    schema: z.object({
      target: z.enum(["node", "exercise", "dashboard"]),
      node_id: z.string().optional().describe("Required for 'node' and 'exercise'"),
    }),
  },
);

export const assistantTools = [queryHypergraph, generateDiagram, navigateUi];
