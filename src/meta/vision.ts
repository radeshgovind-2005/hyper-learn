import { z } from "zod";
import type { PageImage } from "../media/contracts.js";
import { FIGURE_KINDS } from "../storage/media.js";
import { type MetaClientConfig, metaFetch } from "./client.js";

// Spark looks at a page: what figures, tables, charts and equations it holds, where they are, and what
// they say (tables as Markdown, equations as LaTeX). One call per page image, through metaFetch with a
// strict JSON schema (docs/hackathon/spike-A.md, S2). The model names and locates; code assigns ids.

/** At most this many figures are kept per page: a slide with more is a collage, not a set of figures. */
export const MAX_FIGURES_PER_PAGE = 4;

const BoxSchema = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() });

export const PageReadSchema = z.object({
  figures: z.array(
    z.object({
      kind: z.enum(FIGURE_KINDS),
      caption: z.string().describe("What it shows, in one short sentence"),
      box: BoxSchema.describe("Where it is: fractions 0..1 of the image width and height, x1,y1 top left, x2,y2 bottom right, including its title and legend"),
      sam_prompt: z.string().describe("One or two words naming the object for a segmentation model: chart, graph, diagram, photo, table, equation"),
      table_markdown: z.string().nullable().describe("For a table: the whole table as a Markdown table, every row and value. Otherwise null"),
      latex: z.string().nullable().describe("For an equation: it in LaTeX, without $ signs. Otherwise null"),
      teaches: z.string().describe("What a learner should take from it, in one sentence"),
    }),
  ),
});
export type PageRead = z.infer<typeof PageReadSchema>;
export type FigureRead = PageRead["figures"][number];

const INSTRUCTION = [
  "List the figures, charts, tables and equations on this page: the things a lesson would show as a picture.",
  "Leave out plain bullet text, page titles, logos, icons and decorations.",
  "Give each one's bounding box as fractions 0..1 of the image (x1,y1 top left; x2,y2 bottom right), including its title and legend.",
  "For a table, write it out as a Markdown table with every row and value. For an equation, write it in LaTeX.",
  "If the page has none, return an empty list.",
].join(" ");

export interface VisionConfig extends MetaClientConfig {
  model: string;
}

/** Reads one page image. Throws on an HTTP error or output that doesn't match the schema. */
export async function readPage(config: VisionConfig, image: PageImage): Promise<FigureRead[]> {
  const res = await metaFetch(config, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: config.model,
      reasoning_effort: "low",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: INSTRUCTION },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "page_figures", strict: true, schema: z.toJSONSchema(PageReadSchema) } },
    }),
  });
  if (!res.ok) throw new Error(`Vision call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision call returned no content");
  return PageReadSchema.parse(JSON.parse(content)).figures.slice(0, MAX_FIGURES_PER_PAGE);
}
