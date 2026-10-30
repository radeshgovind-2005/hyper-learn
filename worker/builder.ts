import type { CourseBuilder, CourseEditor } from "../src/app/courses.js";
import { createEditModels } from "../src/edit/models.js";
import { runEdit } from "../src/edit/run.js";
import { generateCourse } from "../src/generate/index.js";

// The course generator a studio course's build() runs, with models on the owner's key.
export const courseBuilder: CourseBuilder = (input, structured, onStep) => generateCourse(input, structured, onStep);

// Owner edits (tune, ask for a change, add a file), with the same models on the owner's key.
export const courseEditor: CourseEditor = (request, context, structured, onStep) => runEdit(request, context, createEditModels(structured), { onStep });
