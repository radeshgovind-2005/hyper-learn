import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getSystemPrompt, renderTemplate } from "../agents.js";
import type { Invokable, StructuredFactory } from "../models.js";

// A narrated storyboard for one section: 4–6 frames with a caption and narration each, at most two of
// them with a generated diagram. Narration is read by the browser's speech synthesis (Meta has no
// text-to-speech), so this is a storyboard, not a generated video.

export const MAX_STORY_PICTURES = 2;

export const StoryboardSchema = z.strictObject({
  title: z.string().min(1).max(120),
  frames: z
    .array(
      z.strictObject({
        caption: z.string().min(1).max(140),
        narration: z.string().min(1).max(400),
        picture: z.boolean(),
        picture_description: z.string().max(300).nullable().describe("What the diagram shows and its labels, or null"),
      }),
    )
    .min(4)
    .max(6),
});
export type StoryboardDraft = z.infer<typeof StoryboardSchema>;

export function storyboardModel(structured: StructuredFactory): Invokable<StoryboardDraft> {
  return structured(StoryboardSchema, "write_storyboard", "reasoning");
}

const MAX_SECTION_CHARS = 12_000;

export async function writeStoryboard(model: Invokable<StoryboardDraft>, sectionText: string): Promise<StoryboardDraft> {
  const user = renderTemplate("tutor", "storyboard", { frames: "4 to 6", section: sectionText.slice(0, MAX_SECTION_CHARS) });
  const draft = StoryboardSchema.parse(await model.invoke([new SystemMessage(getSystemPrompt("tutor")), new HumanMessage(user)]));
  // Code keeps the picture cap whatever the model marked.
  let pictures = 0;
  return {
    ...draft,
    frames: draft.frames.map((f) => {
      const picture = f.picture && Boolean(f.picture_description?.trim()) && pictures < MAX_STORY_PICTURES;
      if (picture) pictures++;
      return { ...f, picture, picture_description: picture ? f.picture_description : null };
    }),
  };
}
