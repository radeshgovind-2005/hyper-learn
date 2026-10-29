import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CourseManifestSchema, type Course } from "./schema.js";
import { buildCourse, parseLessonFile } from "./validate.js";

// Node only: reads the Markdown course from disk. Used to compile the bundle (`npm run bundle`) and by
// the test that keeps it up to date; everything else uses getCourse() from ./bundle.ts.

export const DEFAULT_COURSE_DIR = fileURLToPath(new URL("../../content/agentic-coding/", import.meta.url));

/** Reads and validates a course directory: course.json plus one Markdown file per lesson. */
export function loadCourse(dir: string = DEFAULT_COURSE_DIR): Course {
  const manifest = CourseManifestSchema.parse(JSON.parse(readFileSync(join(dir, "course.json"), "utf8")));
  const lessons = manifest.lessons.map((meta) => parseLessonFile(meta, readFileSync(join(dir, meta.file), "utf8")));
  return buildCourse(manifest, lessons);
}

