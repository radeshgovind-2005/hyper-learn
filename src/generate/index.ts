// Course generation: the app calls generateCourse (or buildCourse with its own models).
export { buildCourse, type BuildOptions, DEFAULT_MAX_CALLS, DEFAULT_MAX_CHARS, generateCourse, MAX_FIX_ROUNDS } from "./build.js";
export { type BuilderModels, createBuilderModels } from "./models.js";
export { cannedBuilderModels } from "./canned.js";
export { studioChecks, type StudioProblem } from "./checks.js";
export { formatReport } from "./report.js";
export { stressTest, type StressResult } from "./stress.js";
export type { BuildInput, BuildReport, BuildResult, BuildStep } from "./types.js";
