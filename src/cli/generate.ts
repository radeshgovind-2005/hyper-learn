import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { slugify } from "../course/compile.js";
import { SOURCE_ROLES, type SourceRole } from "../course/sources.js";
import { buildCourse, type BuildOptions } from "../generate/build.js";
import { cannedBuilderModels } from "../generate/canned.js";
import { createBuilderModels } from "../generate/models.js";
import { formatReport } from "../generate/report.js";
import type { BuildInput } from "../generate/types.js";
import { readSourceFiles, type SourceFile } from "./generate-sources.js";

/**
 * Builds a course from local files with the generation pipeline (src/generate), outside the app.
 * Writes snapshot.json (when the build succeeds) and report.md to --out.
 *
 *   npm run generate -- --title "Caches" --goal "Size a cache" notes.md lec*.pdf --assessment exam.pdf
 *   npm run generate -- --title "Caches" notes.md --dry-run    canned models: no model calls, tests the plumbing
 *
 * Files: .md / .txt (one page each), .pages.json (an array of page strings), .pdf (needs pdftotext).
 * --material / --assessment / --brief <file> add a file with its role set; others are classified.
 * Other options: --id, --description, --language, --out (default generated/), --per-objective N,
 * --max-chars N, --max-calls N, --no-review, --no-stress.
 */

const USAGE = 'Usage: npm run generate -- --title "…" [--goal "…"] [--dry-run] [--out dir] <files…>';

export interface GenerateArgs {
  input: BuildInput;
  files: SourceFile[];
  out: string;
  dryRun: boolean;
  options: Omit<BuildOptions, "onStep">;
}

export function parseArgs(argv: readonly string[]): GenerateArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const files: SourceFile[] = [];
  const valued = new Set(["title", "goal", "description", "language", "id", "out", "per-objective", "max-chars", "max-calls"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      files.push({ path: arg });
      continue;
    }
    const name = arg.slice(2);
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value\n${USAGE}`);
      return value;
    };
    if ((SOURCE_ROLES as readonly string[]).includes(name)) files.push({ path: next(), role: name as SourceRole });
    else if (valued.has(name)) values[name] = next();
    else if (["dry-run", "no-review", "no-stress"].includes(name)) flags.add(name);
    else throw new Error(`Unknown option --${name}\n${USAGE}`);
  }
  const title = values.title?.trim();
  if (!title) throw new Error(`--title is required\n${USAGE}`);
  if (files.length === 0) throw new Error(`Give at least one file\n${USAGE}`);
  const number = (name: string) => {
    if (values[name] === undefined) return undefined;
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
    return n;
  };

  const perObjective = number("per-objective");
  const maxChars = number("max-chars");
  const maxCalls = number("max-calls");
  return {
    input: {
      course_id: values.id ?? (slugify(title) || "generated-course"),
      title,
      ...(values.goal && { goal: values.goal }),
      ...(values.description && { description: values.description }),
      ...(values.language && { language: values.language }),
      sources: [],
    },
    files,
    out: values.out ?? "generated",
    dryRun: flags.has("dry-run"),
    options: {
      ...(perObjective !== undefined && { perObjective }),
      ...(maxChars !== undefined && { maxChars }),
      ...(maxCalls !== undefined && { maxCalls }),
      ...(flags.has("no-review") && { review: false }),
      ...(flags.has("no-stress") && { stress: false }),
    },
  };
}

/** Runs one build; returns the process exit code (0 = a course was built). */
export async function runGenerate(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv);
  const { sources, notes } = readSourceFiles(args.files);
  for (const note of notes) log(`note: ${note}`);
  const input: BuildInput = { ...args.input, sources };

  let models;
  if (args.dryRun) {
    log("Dry run: canned models, no model calls. The content is mechanical, not a real course.");
    models = cannedBuilderModels();
  } else {
    // Only a real run reads the model settings (.env).
    await import("../node/setup.js");
    const { getStructuredModel } = await import("../models.js");
    models = createBuilderModels(getStructuredModel);
  }

  const result = await buildCourse(input, models, {
    ...args.options,
    onStep: (step) => log(`[${step.stage}] ${step.status === "ok" ? "" : `${step.status}: `}${step.title}`),
  });

  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.md"), formatReport(input, result));
  if (result.ok) writeFileSync(join(out, "snapshot.json"), `${JSON.stringify(result.snapshot, null, 2)}\n`);
  log(result.ok ? `Wrote ${join(out, "snapshot.json")} and report.md (${result.report.model_calls} model calls).` : `Not built; see ${join(out, "report.md")}.`);
  for (const warning of result.report.warnings) log(`warning: ${warning}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runGenerate(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
