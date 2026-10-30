import type { CoachRepairer, CourseBuilder, CourseEditor } from "../src/app/courses.js";
import { writeRepair } from "../src/coach/repair.js";
import { createBuilderModels } from "../src/generate/models.js";
import { createEditModels } from "../src/edit/models.js";
import { runEdit } from "../src/edit/run.js";
import { generateCourse } from "../src/generate/index.js";

// The course generator a studio course's build() runs, with models on the owner's key.
export const courseBuilder: CourseBuilder = (input, structured, onStep) => generateCourse(input, structured, onStep);

// Owner edits (tune, ask for a change, add a file), with the same models on the owner's key.
export const courseEditor: CourseEditor = (request, context, structured, onStep) => runEdit(request, context, createEditModels(structured), { onStep });

// The study coach's personal lessons: the build's writer and fact checker, on the owner's key.
export const coachRepairer: CoachRepairer = (input, structured) => writeRepair(input, createBuilderModels(structured));
