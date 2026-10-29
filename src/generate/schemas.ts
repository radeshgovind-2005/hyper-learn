import { z } from "zod";
import { SOURCE_ROLES } from "../course/sources.js";

// What the generation agents return. Every key is required (nullable where it may be empty) because
// they fill these through strict JSON-schema structured output, and nothing here is an id: models
// refer to lessons, sections, objectives and misconceptions by their number in the prompt (or echo a
// prerequisite id they were shown), and code assigns every id and checks every reference.
// Counts (3–8 lessons, 2–5 objectives…) are asked for in the prompts and enforced in code, not in the
// schemas, so a draft with a wrong count comes back as a fixable problem instead of a parse failure.

const PageRefSchema = z.object({
  source: z.string().describe("Source id as given, e.g. 's1'"),
  page: z.number().int().describe("1-based page number"),
});

export const ClassificationSchema = z.object({
  role: z.enum(SOURCE_ROLES),
  reason: z.string().describe("One sentence"),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const DigestSchema = z.object({
  points: z.array(
    z.object({
      text: z.string().describe("One or two sentences"),
      pages: z.array(z.number().int()).describe("Page numbers this point comes from"),
    }),
  ),
});
export type DigestDraft = z.infer<typeof DigestSchema>;

export const PlanDraftSchema = z.object({
  lessons: z.array(
    z.object({
      title: z.string(),
      summary: z.string().describe("One or two sentences: what the lesson teaches"),
      prerequisites: z.array(z.number().int()).describe("Numbers of EARLIER lessons in this list (1-based) it directly builds on"),
      sections: z.array(
        z.object({
          title: z.string(),
          pages: z.array(PageRefSchema).describe("Teaching-material pages this section is written from"),
        }),
      ),
      objectives: z.array(
        z.object({
          statement: z.string().describe("One testable statement starting with a verb"),
          sections: z.array(z.number().int()).describe("Numbers (1-based, within this lesson) of the sections that teach it"),
        }),
      ),
    }),
  ),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

export const SectionDraftSchema = z.object({
  blocks: z.array(
    z.object({
      markdown: z.string().describe("A paragraph, a bullet list or a fenced code block; no headings"),
      cites: z.array(PageRefSchema).describe("The pages this block is based on"),
    }),
  ),
  check: z.object({
    prompt: z.string(),
    options: z.array(
      z.object({
        text: z.string(),
        correct: z.boolean(),
        feedback: z.string().describe("Shown after the learner picks this option: why it is right or wrong"),
      }),
    ),
  }),
});
export type SectionDraft = z.infer<typeof SectionDraftSchema>;

/** Only these item types are generated: they are graded in code and simulate well. */
export const GENERATED_ITEM_TYPES = ["single_choice", "multi_select", "two_tier", "ordering"] as const;

const DraftOptionSchema = z.object({
  text: z.string(),
  correct: z.boolean(),
  gap: z.string().nullable().describe("Id of the prerequisite lesson this wrong option reveals a gap in, or null"),
  misconception: z.number().int().nullable().describe("Number of the misconception this wrong option expresses, or null"),
});

export const AssessmentDraftSchema = z.object({
  misconceptions: z.array(
    z.object({
      name: z.string().describe("2 to 4 words"),
      belief: z.string().describe("The wrong belief, as the learner would hold it"),
    }),
  ),
  items: z.array(
    z.object({
      objective: z.number().int().describe("Number of the objective it tests"),
      type: z.enum(GENERATED_ITEM_TYPES),
      prompt: z.string(),
      options: z.array(DraftOptionSchema).describe("Answer options; [] for ordering"),
      reason_prompt: z.string().nullable().describe("two_tier only, else null"),
      reasons: z.array(DraftOptionSchema).describe("two_tier only, else []"),
      steps: z.array(z.string()).describe("ordering only, in the correct order; else []"),
      wrong_orders: z
        .array(
          z.object({
            later: z.number().int().describe("1-based number of the step placed too early"),
            earlier: z.number().int().describe("1-based number of the step it is wrongly placed before"),
            gap: z.string().nullable(),
            misconception: z.number().int().nullable(),
          }),
        )
        .describe("ordering only, else []"),
    }),
  ),
});
export type AssessmentDraft = z.infer<typeof AssessmentDraftSchema>;
export type ItemDraft = AssessmentDraft["items"][number];
export type OptionDraft = z.infer<typeof DraftOptionSchema>;

export const GroundingVerdictSchema = z.object({
  supported: z.boolean().describe("true only if every claim is supported by its cited pages"),
  unsupported: z.array(z.string()).describe("Each unsupported claim, quoted briefly, with what the pages say instead"),
});
export type GroundingVerdict = z.infer<typeof GroundingVerdictSchema>;
