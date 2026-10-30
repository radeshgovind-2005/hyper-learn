# Workstream B: course generation, notes

Branch `studio/generate`. Everything lives in `src/generate/`, plus six agents in `src/config/agents.json`
(names added to `AGENT_NAMES`), the CLI in `src/cli/generate*.ts` and a `generate` script in `package.json`.

## What the app calls

```ts
import { generateCourse, buildCourse, createBuilderModels, formatReport } from "./src/generate/index.js";

// Matches C's CourseBuilder: (input, structured, onStep) => Promise<BuildResult>
generateCourse(input: BuildInput, structured: StructuredFactory, onStep?: (step: BuildStep) => void,
               options?: Omit<BuildOptions, "onStep">): Promise<BuildResult>

// The same with models injected (tests, or a caller that wraps models itself)
buildCourse(input: BuildInput, models: BuilderModels, options?: BuildOptions): Promise<BuildResult>
createBuilderModels(structured: StructuredFactory): BuilderModels
formatReport(input: BuildInput, result: BuildResult): string   // Markdown for the owner
```

`BuildOptions`: `onStep`, `maxChars` (24 000), `maxCalls` (400), `perObjective` (2, changed at integration), `limits` (3–8 lessons,
2–5 objectives), `review` (true), `stress` (true), `concurrency` (4). The Phase 0 contract in `types.ts` is
unchanged. `ok: true` carries a v1.0.0 snapshot that `courseFromSnapshot` accepts; publishing it is the app's job.

## Pipeline

| Step | Code (`src/generate/`) | Model calls |
|---|---|---|
| 1 Classify | `sources.ts` `classifySource`: owner's role, then whole-word file-name hints (exam, test, quiz, project, brief, lecture, notes…), then the `classifier` on the first 3 000 chars | 0–1 per source |
| 2 Digest | `sources.ts` `digestSource`: consecutive pages packed into chunks that fit; points keep only pages that were in the chunk; assessment/brief points that copy the document's own sentences are dropped | 1 per chunk |
| 3 Plan | `plan.ts`: `planner` sees key ideas as `[s1 p.3] idea` lines (sampled evenly if too many) and what assessments evaluate; code slugs ids, checks counts, page refs, prerequisites (only earlier lessons, so the graph is a DAG by construction), objective → section refs | 1 (+≤3 fixes) |
| 4 Write | `write.ts`: `writer` per section, sees only that section's pages; each block must cite one of them; Markdown sanitized; the practice question becomes a check block | 1 per section |
| 5 Assess | `assess.ts`: `examiner` once per objective writes `2×per_objective+1` items; the first call also writes the lesson's 2–4 misconceptions, the others are given them; code merges the drafts, assigns ids and checks every tag | 1 per objective |
| 6 Validate | `build.ts` + `assemble.ts` + `checks.ts`: per-unit problems, then `studioChecks` and `courseFromSnapshot` on the assembled snapshot; problems go back to the writer (per section) or examiner (per lesson), ≤3 rounds, else `ok: false` | fixes only |
| 7 Review | `review.ts`: `fact_checker` per section against its cited pages; a doubted section is rewritten once and checked again; still doubted = warning; a rewrite that breaks a rule is reverted | 1 per section (+2 per doubted one) |
| 8 Stress | `stress.ts`: removes one real edge, `simulate` → `computePerformance` → `referenceCurator`; miss = warning | 0 |
| 9 Shuffle | `assemble.ts` `shuffleOptions`: every option list (and check block) shuffled, seeded by course and item id; after validation, since fix rounds name options by their drafted number | 0 |

Every call goes through `ModelCalls` (`models.ts`): it refuses a prompt over `maxChars` (system prompt
included), stops the build at `maxCalls` (`CallBudgetExceeded` → `ok: false`), retries a failed call up to
3 times (after 2 s, 8 s and 30 s; not on a 4xx that would fail again) and counts calls for
`report.model_calls`. A per-section or per-lesson call that still fails becomes a problem for the next fix
round instead of ending the build. Calls run up to `concurrency` at a time.

Typical cost: digest chunks + 1 plan + S sections + O objectives + S fact checks, e.g. ~55 calls for 5 lessons,
15 sections, 15 objectives and 6 chunks of material, before fixes.

## Decisions

- **No LangGraph graph.** A plain async pipeline with bounded loops; nothing here needs checkpoints or
  interrupts, and the state (plan, units) is simpler as local maps. "Resumable in spirit": each step only
  depends on the previous step's checked output.
- **Numbers, not ids, from models.** Lessons' prerequisites are numbers of *earlier* lessons; objectives
  reference section numbers; items reference objective and misconception numbers. Only prerequisite ids
  are echoed (the examiner sees them) and they are checked against the lesson's prerequisites.
- **Flat item draft.** One schema for the four types (`options`, `reason_prompt`, `reasons`, `steps`,
  `wrong_orders`, unused ones empty or null) instead of a union: simpler for strict JSON schema and for
  weaker models. Code converts per type and runs `QuizItemSchema` and `checkItem`. Ordering mistakes are
  written as "step `later` placed before step `earlier`", 1-based, and converted to `patterns`.
- **Counts are not in the schemas.** No `min`/`max` on model-facing arrays: a wrong count is a fixable
  problem, not a parse failure that wastes the call.
- **Gaps only on direct prerequisites; misconception tags only with `gap: null`.** A wrong option either
  reveals a gap in a direct prerequisite or names one of *this* lesson's misconceptions. That is always
  valid under `validateCourse` (a misconception tag must point at the lesson that teaches it) and keeps
  the examiner's job simple. Cost: no option names a prerequisite's misconception.
- **Misconception ids** are slugs of the model's 2–4 word names, unique across lessons (other lessons'
  current ids are taken; the unit is stored before another conversion can run).
- **Ids**: lessons = slug of title (max 40 chars, `lesson-N` if the title has no Latin letters), sections
  `<lesson>/<slug>`, blocks `<section>/<p|l|c><n>` and `<section>/k1`, objectives `<lesson>-o<n>`, items
  `<lesson>-q<n>`.
- **Check blocks** carry `misconception: null` on every option (they are written before misconceptions
  exist) and practise the first objective that lists their section.
- **Grounding is stricter than "a real page"**: a block may only cite the pages planned for its section
  (the only pages the writer saw). `studioChecks` also rejects citations to assessment/brief pages.
- **Sanitizing instead of rejecting Markdown.** `LessonView` renders blocks with `marked` and
  `dangerouslySetInnerHTML`, and source text is owner-uploaded, so generated Markdown is cleaned in code:
  `<` escaped outside code, images → alt text, links only to http(s), headings → bold (a `## ` line would
  also split the section when the lesson is rendered). Fenced code is left alone (marked escapes it).
- **Copy check**: an item prompt (and a two-tier reason prompt) is rejected when it shares ≥ 0.7 of its
  content words with a sentence of an assessment source (`overlap` from `interventions/checks.ts`).
  Sentences with fewer than 6 content words are ignored: `overlap` divides by the smaller set, so a short
  exam line like "Define pipelining." would otherwise flag every question that mentions pipelining. The
  exam text itself never reaches the writer or examiner, only the digester's description of it.
- **Fewer lessons for tiny inputs** (deviation): when the material has fewer non-empty pages than the
  lesson minimum, the minimum drops to the page count, with a warning.
- **Pool size**: the examiner is asked for `2×per_objective+1` per objective; fewer than `2×per_objective`
  is a problem (A's rule), in between is a warning.
- **Fix rounds**: the plan has its own ≤3 retries; validate→fix is ≤3 rounds over sections and lessons.
  Fix requests show the previous draft (shortened to a third of the room) and up to 30 problems.
- **Canned models** (`canned.ts`) read the pipeline's own prompts and answer with mechanical, valid
  drafts. They power `--dry-run` and the tests (wrapped in spies with per-agent overrides in
  `fixtures.test-helpers.ts`). They are prompt-driven, not call-order scripted, so concurrency doesn't
  break tests.

## Generation's own checks

`checks.ts` `studioChecks` used to mirror PLAN A item 3 while A's validator wasn't on this branch. Since
integration it keeps only generation's own rules: the four generated item types, every text block cites a
real material page, no copied assessment questions. The objective, pool-size and check-block rules come
from A's validator inside `courseFromSnapshot`; any problem it reports that names an id in quotes is routed
back to the section's writer or the lesson's examiner (`routeValidationError`), and within a lesson to the
examiner call that wrote the question (`problemsByPart`).

## Stress test

`stressEdge` picks an edge whose prerequisite isn't also reached through another prerequisite (else
removing it frees nobody), preferring the lesson with the largest share of questions that can reveal the
gap. Detection needs that share to be high: the simulated learner who lacks the prerequisite picks a
gap-revealing option when the item has one (80%), otherwise an untagged one, which points at the lesson
itself. With every item tagged (canned course) it's detected; with only 1 of 6 tagged it is missed (test
"misses the removed edge when few questions can reveal it"). So the examiner is told "most questions need
a wrong option tagged with each prerequisite", and `assess.ts` warns when fewer than half can reveal a
prerequisite. After A's change, simulated attempts draw `per_objective` items per objective, so the share
per attempt is what matters, not the pool total; the warning still measures the right thing.

## For the integrator

- Wire `generateCourse` as C's `CourseBuilder`. `onStep` gets every `BuildStep` (several per stage).
- Run `npm test` on top of A: `generate.test.ts` asserts `courseFromSnapshot` accepts the generated
  snapshot, so A's objective/exam/check rules get exercised by it. Item field names I rely on:
  `objective` on items, `exam.per_objective` on lessons, `CheckBlock.objective`, `TextBlock.cites`.
- `courseFromSnapshot` doesn't pass `snapshot.objectives` to `buildCourse` yet (Phase 0); A probably
  changes that. Nothing in B depends on `Course.objectives`.
- The web app should also sanitize when rendering blocks; B's sanitizing protects generated content only.
- Real runs: `npm run generate -- --title "…" files…` reads model settings from `.env` through
  `src/node/setup.ts`. `--dry-run` never loads them. Output goes to `generated/` (gitignored).

## Known weaknesses with a real model

- **Untested against a real model.** Prompts are designed, not tuned; expect fix rounds on the first runs,
  mostly on the examiner (tag discipline, two-tier/ordering fields, counts). If a lesson can't converge in
  3 rounds the whole build fails; dropping or re-planning that lesson would be a better fallback.
- **One examiner call per objective** (since integration): 5 items each at `per_objective: 2`. Fix rounds
  re-ask only the calls whose questions have problems (`problemsByPart`), except that new misconceptions
  re-ask every call of that lesson, since their tags would be stale.
- **Fact checking is a model's judgement** of claims against (possibly shortened) pages. Long pages are
  cut proportionally to fit `maxChars`, so the writer and checker may not see a whole page; citations
  still point at the page.
- **Digest sampling**: for very large uploads the planner sees an even sample of key ideas, so it may miss
  topics; there is a warning but no second planning pass.
- **Language**: `overlap`/`contentWords` only count `[a-z0-9_]`, so the copy check is weak for non-Latin
  scripts (and slugs fall back to `lesson-N` etc.).
- **Quality isn't measured.** Valid structure, grounded citations and a detectable prerequisite are
  checked; whether the questions are good is not. Item statistics from real learners (the existing
  harness) are what will tell.
- **Sequential classify**, and digest calls within one source run one after another (sources run in
  parallel).
