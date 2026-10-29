import type { CourseBuilder } from "../src/app/courses.js";
import { generateCourse } from "../src/generate/index.js";

// The course generator a studio course's build() runs, with models on the owner's key.
export const courseBuilder: CourseBuilder = (input, structured, onStep) => generateCourse(input, structured, onStep);
