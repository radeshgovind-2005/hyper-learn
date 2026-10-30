import { z } from "zod";
import { PageRefSchema } from "../generate/schemas.js";

// What the editor agent returns: edits by id and title. Code checks every id and page, assigns new ids,
// and has the generation agents write the content (src/edit/run.ts).

const SectionPlanSchema = z.object({
  title: z.string(),
  pages: z.array(PageRefSchema).describe("Teaching-material pages it is written from"),
});

export const EditPlanDraftSchema = z.object({
  reply: z.string().describe("One or two sentences to the owner: what will change, or why nothing can"),
  rewrite_sections: z.array(
    z.object({
      section: z.string().describe("Id of an existing section"),
      instruction: z.string().describe("What its writer should change, and how"),
    }),
  ),
  new_sections: z.array(
    z.object({
      lesson: z.string().describe("Id of an existing lesson"),
      after: z.string().nullable().describe("Id of the section it follows, or null to come first"),
      ...SectionPlanSchema.shape,
      objectives: z.array(z.string()).describe("Ids of existing objectives of this lesson it helps teach"),
      instruction: z.string(),
    }),
  ),
  new_lessons: z.array(
    z.object({
      after: z.string().nullable().describe("Id of the lesson it follows, or null to come first"),
      title: z.string(),
      summary: z.string(),
      prerequisites: z.array(z.string()).describe("Ids of lessons it builds on, up to and including `after`"),
      sections: z.array(SectionPlanSchema),
      objectives: z.array(
        z.object({
          statement: z.string(),
          sections: z.array(z.number().int()).describe("1-based numbers of this lesson's sections that teach it"),
        }),
      ),
    }),
  ),
  new_objectives: z.array(
    z.object({
      lesson: z.string(),
      statement: z.string(),
      sections: z.array(z.string()).describe("Ids of existing sections, or titles of new_sections in this lesson"),
    }),
  ),
  more_questions: z.array(
    z.object({
      objective: z.string().describe("Id of an existing objective"),
      instruction: z.string(),
    }),
  ),
});
export type EditPlanDraft = z.infer<typeof EditPlanDraftSchema>;
