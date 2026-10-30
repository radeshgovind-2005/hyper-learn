import { getAgent } from "../agents.js";
import { type BuilderModels, createBuilderModels } from "../generate/models.js";
import type { Invokable, StructuredFactory } from "../models.js";
import { type EditPlanDraft, EditPlanDraftSchema } from "./schemas.js";

/** The generation agents plus the editor, which turns a request into an edit list. */
export interface EditModels extends BuilderModels {
  editor: Invokable<EditPlanDraft>;
}

export function createEditModels(structured: StructuredFactory): EditModels {
  return { ...createBuilderModels(structured), editor: structured(EditPlanDraftSchema, "plan_edits", getAgent("editor").model) };
}
