import { writeFileSync } from "node:fs";
import { compileCourse } from "../course/compile.js";
import { getCourse } from "../course/bundle.js";

/**
 * Compiles the Markdown course into release v1.0.0: content/agentic-coding.bundle.json.
 * The Worker imports this file (it has no filesystem); a test fails if it is out of date.
 *
 *   npm run bundle
 */
export const BUNDLE_PATH = new URL("../../content/agentic-coding.bundle.json", import.meta.url);

const snapshot = compileCourse(getCourse());
writeFileSync(BUNDLE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
const blocks = snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks)).length;
console.log(`Wrote ${BUNDLE_PATH.pathname}: v${snapshot.version}, ${snapshot.lessons.length} lessons, ${blocks} blocks`);
