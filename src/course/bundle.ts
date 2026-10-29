import bundle from "../../content/agentic-coding.bundle.json" with { type: "json" };
import { type CourseSnapshot, courseFromSnapshot } from "./compile.js";
import type { Course } from "./schema.js";

// The course as compiled into release v1.0.0 (`npm run bundle`). Importing JSON instead of reading
// Markdown keeps the core free of the filesystem, so the same code runs in Node and in the Worker.
// A test fails if the bundle is out of date with the Markdown.

/** A fresh copy of the v1.0.0 snapshot: the release a new course store starts from. */
export const baseSnapshot = (): CourseSnapshot => structuredClone(bundle as CourseSnapshot);

let cached: Course | undefined;

/** The course (v1.0.0), validated once. */
export function getCourse(): Course {
  cached ??= courseFromSnapshot(bundle as CourseSnapshot);
  return cached;
}
