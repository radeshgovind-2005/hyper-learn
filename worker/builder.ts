import type { CourseBuilder } from "../src/app/courses.js";

// The course generator a studio course's build() runs. Generation (src/generate, workstream B) plugs in
// here; until then builds are refused with "Course generation isn't available on this server yet".
// Integration: (input, structured, onStep) => buildCourse(input, createBuilderModels(structured), { onStep })
export const courseBuilder: CourseBuilder | undefined = undefined;
