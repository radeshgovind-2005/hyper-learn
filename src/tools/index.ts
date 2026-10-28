import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import { dependentsOf } from "../course/graph.js";
import { getCourse } from "../course/load.js";
import { logNode } from "../utils/logger.js";

// Tool results go back into a small (4k) context window, so keep them compact.
const toJson = (value: unknown) => JSON.stringify(value);

/** Longest lesson excerpt read_lesson returns, to stay within the local model's context. */
const LESSON_EXCERPT_CHARS = 1_200;

const lessonList = () => getCourse().lessons.map(({ id, title }) => ({ id, title }));
const titleOf = (id: string) => getCourse().getLesson(id)?.title ?? id;

// ─── Tools ─────────────────────────────────────────────────────────

export const queryHypergraph = tool(
  async ({ node_id, topic }) => {
    logNode("tools", "query_hypergraph", { node_id, topic });
    const course = getCourse();
    const needle = topic?.toLowerCase();
    const matches = course.lessons.filter(
      (lesson) =>
        lesson.id === node_id ||
        (needle !== undefined && `${lesson.title} ${lesson.summary}`.toLowerCase().includes(needle)),
    );
    if (matches.length === 0) return toJson({ error: "No matching lesson", available: lessonList() });

    return toJson(
      matches.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        summary: lesson.summary,
        prerequisites: lesson.prerequisites.map((id) => ({ id, title: titleOf(id) })),
        dependents: dependentsOf(course.graph, lesson.id),
        quiz_questions: lesson.quiz.length,
      })),
    );
  },
  {
    name: "query_hypergraph",
    description:
      "Look up lessons in the course hypergraph by lesson id or topic keyword. Returns each lesson's summary, prerequisites and dependents.",
    schema: z.object({
      node_id: z.string().optional().describe("Exact lesson id, e.g. 'tool-calling'"),
      topic: z.string().optional().describe("Keyword to search lesson titles and summaries, e.g. 'tool'"),
    }),
  },
);

export const readLesson = tool(
  async ({ node_id }) => {
    logNode("tools", "read_lesson", { node_id });
    const lesson = getCourse().getLesson(node_id);
    if (!lesson) return toJson({ error: `Unknown lesson "${node_id}"`, available: lessonList() });

    const truncated = lesson.body.length > LESSON_EXCERPT_CHARS;
    return toJson({
      id: lesson.id,
      title: lesson.title,
      text: truncated ? `${lesson.body.slice(0, LESSON_EXCERPT_CHARS)}…` : lesson.body,
      truncated,
    });
  },
  {
    name: "read_lesson",
    description: "Read the text of one lesson (possibly truncated) to explain or quote its content.",
    schema: z.object({ node_id: z.string().describe("Lesson id, e.g. 'agent-loop'") }),
  },
);

export const generateDiagram = tool(
  async ({ node_ids, kind }) => {
    logNode("tools", "generate_diagram", { node_ids, kind });
    const course = getCourse();
    const lessons = node_ids.flatMap((id) => course.getLesson(id) ?? []);
    const ids = new Set(lessons.map((lesson) => lesson.id));
    const lines = lessons.flatMap((lesson) => [
      `  ${lesson.id}["${lesson.title}"]`,
      ...lesson.prerequisites
        .filter((prereq) => kind === "concept_map" || ids.has(prereq))
        .map((prereq) => `  ${prereq} --> ${lesson.id}`),
    ]);
    return toJson({ format: "mermaid", diagram: ["graph TD", ...lines].join("\n") });
  },
  {
    name: "generate_diagram",
    description:
      "Generate a Mermaid diagram of the given lessons. 'prerequisite_map' shows only edges among the given lessons; 'concept_map' also shows edges to outside prerequisites.",
    schema: z.object({
      node_ids: z.array(z.string()).min(1).describe("Lesson ids to include"),
      kind: z.enum(["prerequisite_map", "concept_map"]).default("prerequisite_map"),
    }),
  },
);

export const navigateUi = tool(
  async ({ target, node_id }) => {
    logNode("tools", "navigate_ui", { target, node_id });
    if (target !== "dashboard" && !(node_id && getCourse().getLesson(node_id))) {
      return toJson({ error: `navigate_ui to "${target}" needs a valid lesson id`, available: lessonList() });
    }
    const path = target === "dashboard" ? "/dashboard" : `/${target}/${node_id}`;
    return toJson({ action: "navigate", path, status: "queued" });
  },
  {
    name: "navigate_ui",
    description: "Navigate the learner's UI to a lesson page, a lesson's quiz, or their dashboard.",
    schema: z.object({
      target: z.enum(["lesson", "quiz", "dashboard"]),
      node_id: z.string().optional().describe("Lesson id; required for 'lesson' and 'quiz'"),
    }),
  },
);

/** Every tool an agent can be given, keyed by the name used in src/config/agents.json. */
export const TOOL_REGISTRY = {
  query_hypergraph: queryHypergraph,
  read_lesson: readLesson,
  generate_diagram: generateDiagram,
  navigate_ui: navigateUi,
} satisfies Record<string, StructuredToolInterface>;

export type ToolName = keyof typeof TOOL_REGISTRY;
export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as [ToolName, ...ToolName[]];
