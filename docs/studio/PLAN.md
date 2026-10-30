# HyperLearn Studio: plan

Owners create a course by dropping in their own files (lectures, book chapters, past exams, a project
brief). Agents work out what is being evaluated, build a learning path with short checks and a
pooled exam, and the owner shares it. Learners take it; the existing harness keeps improving it. A
grounded tutor answers questions with citations, and owners ask for changes in plain words, which
become releases.

Read `CLAUDE.md` first. Every rule there applies (boundaries, "agents propose, code decides", style).

## Terms

```
Course ── objectives (what mastery means, one testable statement each)
  └─ Lesson (a broad unit; ends in an exam drawn from its pool)
       ├─ Section (a small unit) ── text blocks (cite source pages) ── check block (practice + feedback)
       └─ quiz = the exam POOL; exam = per_objective items drawn per attempt, unseen ones first
Source  = an uploaded document as page texts; role: material | assessment | brief
```

Answers to exam items point at an objective, so a failed exam says "review §<section>" for the
objectives missed. A retake draws different items. Courses without objectives (the featured
`agentic-coding` course) behave exactly as today.

## Already in place (Phase 0, branch `studio/base`)

- `src/course/schema.ts`: `ObjectiveSchema`, `ExamConfigSchema`, `CitationSchema`; `Course.objectives`.
- `src/course/compile.ts`: `CheckBlock` (kind `check`, id prefix `k`), `isTextBlock`, `TextBlock.cites?`,
  `LessonNode.exam?`, `CourseSnapshot.objectives?`.
- `src/assessment/items.ts`: optional `objective` on every quiz item.
- `src/course/sources.ts`: `Source`, roles, `citedPage`.
- `src/generate/types.ts`: `BuildInput`, `BuildStep`, `BuildReport`, `BuildResult` (the generator ↔ app contract).
- `src/models.ts`: `StructuredFactory` type.
- `web/src/components/LessonView.tsx`: check blocks render nothing until wave 2.

These are shared. Change them only if you must, say so in your notes, and keep them backward compatible.

## Wave 1 workstreams

Each runs in its own git worktree and branch. Stay inside your files; if you must touch another
stream's file, keep the change minimal and list it in your notes.

### A — Assessment v2 (`studio/assessment`)

Owns: `src/assessment/**`, `src/course/{compile,validate,graph}.ts` (beyond Phase 0), `src/analytics/**`,
`src/simulation/learners.ts`, `src/measure/**`, `src/path/**`, and in `src/app/service.ts` only
`submitQuiz`, `progress` and new learner methods listed below.

1. **Answers keyed by item.** `QuizAttempt.item_ids?: string[]` (the items shown, in order; absent = the
   whole quiz, as today). `gradeAttempt` and everything downstream (analytics, measure, learner
   summaries) use it. Old stored answer events must still grade.
2. **`drawExam(lesson, objectives, { seen, seed })`**, pure and deterministic: `per_objective` scored
   items per objective of that lesson, unseen first, then least-recently seen; items without an
   objective are drawn as if one extra objective. No `exam` config = every item. Order shuffled by seed.
3. **Validation** (in `validateCourse`/`courseFromSnapshot`, only when a course has objectives): ids unique;
   objective's lesson exists and its sections are real sections of that lesson; every scored item of a
   lesson with objectives names one of that lesson's objectives; each objective has at least
   `2 × per_objective` scored items (so a retake can be fresh); check blocks have exactly one correct
   option, the correct one has `misconception: null`, misconceptions exist in the catalog; a check's
   `objective` exists. All existing rules keep applying to the pool.
4. **Router.** New step `{ kind: "review_section", lesson, section_id, objective, reason }` for each
   objective with a wrong answer (its sections, first one only), after interventions and before
   prerequisite reviews and the retake.
5. **Analytics.** Item statistics with sparse responses (an item is judged only on attempts that showed
   it). Optional `objectives` on `NodePerformance` (miss rate per objective) is welcome if it stays
   compact; keep the Curator's input shape otherwise unchanged.
6. **Simulation.** With an `exam` config, each simulated attempt draws its items (seeded) and records
   `item_ids`; a retake draws again. Scenarios on the featured course are unchanged and must keep
   giving the same results (they have no exam config).
7. **Service (learners).** `exam(learner, lessonId)`: the items this learner gets now on their served
   release, drawn with a seed from (learner, lesson, attempt number, release) so the server can
   recompute it. `submitQuiz(learner, lessonId, answers, certainty, session, item_ids?)` refuses
   `item_ids` that don't match that draw. `answerCheck(learner, blockId, option)` returns
   `{ correct, feedback }` and records an event of kind `check` (append-only, pinned to the served release).
8. **Fixture.** A small made-up course (3 lessons, objectives, pools, checks) in test code, used by A's
   tests and reusable by others (`src/course/fixtures/studio-course.ts`, exported).

Done when: the 241 existing tests pass unchanged (or with mechanical updates), new tests cover 1–8, and
`npm run typecheck` passes.

### B — Course generation (`studio/generate`)

Owns: `src/generate/**` (except the Phase 0 contract, which you may extend), new agents in
`src/config/agents.json` and their names in `src/agents.ts`, `src/cli/generate.ts`, a `generate` script
in `package.json`.

`buildCourse(input: BuildInput, models: BuilderModels, options): Promise<BuildResult>`, plus
`createBuilderModels(structured: StructuredFactory)`. A LangGraph graph is welcome but not required;
what matters is bounded, resumable-in-spirit steps and progress through `options.onStep`.

1. **Classify** each source as material / assessment / brief (owner's role wins; filename hints such as
   exam/test/project/brief; a model call only if unclear).
2. **Digest** (map): per source, page chunks within a char budget → key ideas with page refs. Assessment
   sources yield "what is evaluated" (skills, question styles), never content to copy.
3. **Plan**: 3–8 lessons, prerequisite DAG, sections per lesson with the pages they draw on, 2–5
   objectives per lesson phrased as testable statements, guided by what the assessments evaluate.
   Code assigns every id (slugs from titles, de-duplicated); models never invent ids.
4. **Write** each section from its pages only: text blocks with `cites`; one check per section.
5. **Assess**: misconceptions per lesson (2–4, each tied to the lesson that teaches the correct idea);
   an exam pool per objective of at least `2 × per_objective + 1` items using only `single_choice`,
   `multi_select`, `two_tier`, `ordering`; wrong options tagged (`reveals_gap_in` for each direct
   prerequisite somewhere in the pool, `misconception` where it fits). `exam: { per_objective: 1 }` by default.
6. **Validate** with `courseFromSnapshot` (all of A's and the existing rules). Problems go back to the
   step that produced them, bounded (≤ 3 rounds). If the course still fails, return `ok: false` with the problems.
7. **Review** grounding: code first (every text block cites a real page; no citation to a page that
   doesn't exist), then a model judges each section's claims against its cited page text. Weak spots
   become warnings or a rewrite (bounded).
8. **Stress test** (code, no model): simulated learners (`simulate`) on the built course with one
   prerequisite edge removed; run `computePerformance` and the reference Curator; report whether the
   missing prerequisite is detected. A miss is a warning, not a failure.

Budgets: every model call's input ≤ `options.maxChars` (default 24 000); total calls bounded and counted
in the report. Write in the material's language unless `input.language` says otherwise.

Tests use scripted fake models (see `src/graph.test.ts` for the pattern) and A's fixture style of
made-up sources. If A's validator rules aren't on your branch yet, write against the Phase 0 types and
note it; integration will run your tests on top of A.

CLI: `npm run generate -- --title "…" [--goal "…"] <files…>` reads `.md`/`.txt` (one page each),
`.pages.json` (array of page strings), and `.pdf` when `pdftotext` is on PATH (Node-only code lives in
`src/cli/`). Writes `snapshot.json` and `report.md` to `--out` (default `generated/`, gitignored).

### C — Platform (`studio/platform`)

Owns: `worker/**`, `wrangler.jsonc`, `src/models.ts` (beyond the Phase 0 type), `src/app/access.ts`,
`src/app/service.ts` (except A's methods), `src/storage/**`, `src/auth/**`, `src/simulation/index.ts`
(signatures only), new `src/app/{directory,courses}.ts`, `src/crypto/**`, README sections for what you add.

1. **Per-course models.** A `ModelProvider` instance (config in, `chat(type)` and a `StructuredFactory`
   out). No tenant state at module level: two courses in one isolate must never share a key. Node
   entry points keep working through a default provider. Node creators (`createCuratorModel` etc.)
   take an optional provider.
2. **Course definitions.** `CourseDefinition { id, base: CourseSnapshot, scenarios, exemplars }`. Built-in
   registry: `agentic-coding` (the bundle, `SCENARIOS`, exemplars). `CourseService` takes a definition or
   loads a generated one from its storage; no `getCourse()` inside the service. Scenario features only
   when the course has scenarios; a reference run that needs an exemplar it doesn't have ends with a
   clear step ("needs a model to write this"), not an error.
3. **One Durable Object per course**, named by course id (`this.name`). Built-in ids, or ids the
   directory created. Anything else: refuse the connection (close 4004) and create nothing.
4. **Directory** (`DirectoryAgent`, one instance): courses (id, title, description, owner, status,
   created_at) and memberships (user, course, role). Callables: `myCourses()` (owned, shared with me, and
   featured), `createCourse({ title, description })` → new id, initialises the course object over RPC.
   Course objects report membership changes to it.
5. **Members and roles per course**, stored in the course object: owner, editor, learner; invite token
   (owner creates/rotates); `join(token)`. Access = course role, plus global admin. The featured course
   keeps today's global-role behaviour. New permission `manage_course` (sources, key, build, publish,
   invites, members).
6. **Sources and the owner's key**, in the course object. `addSource({ name, pages, role? })` with limits
   (≤ 30 sources, ≤ 2 000 000 chars total; messages may need chunking: `appendPages`), `removeSource`,
   `setSourceRole`. `setModelKey(key, model)`: AES-GCM with a key derived from the Worker secret
   `KEY_ENCRYPTION_SECRET` (refuse with a clear message if unset); never returned, never logged;
   `settings()` says `{ hasKey, model }`. Models allowed: `MODEL_CHOICES` (comma list, default
   `REASONING_MODEL`); base URL is always the Worker's `MODEL_BASE_URL`, never user input.
7. **Lifecycle.** `draft → building → review → published` (and back to `building` on rebuild). `build()`
   runs an injected `CourseBuilder` (`(input: BuildInput, structured: StructuredFactory, onStep) =>
   Promise<BuildResult>`) in the background with the owner's key; steps reach the UI through state like
   repair runs. `publish()` makes the built snapshot release 1.0.0, live. Learners can't learn a draft.
   Tests use a fake builder; integration wires B's.
8. Tests on Node SQLite for service, directory, access and crypto (WebCrypto exists in Node).

## Wave 2 (after integration)

- **D — Tutor and owner edits.** Grounded tutor (`ask` with page/section context, saved per learner and
  course); answers cite `[§section-id]` or `[source p.N]`; code checks every citation exists and every
  quote appears in the cited text, else the answer isn't shown. "Explain differently" returns an
  existing template (contrast, practice, step-through). A `replace_block` change (exact inverse, R1).
  Owners ask for changes in chat → a proposal → the existing harness (validate, tier, version) →
  owner approval → release.
- **E — Studio UI.** Course sidebar (mine, shared with me, featured), create page (title, description,
  goal, drag-and-drop PDF/MD/TXT; PDF text extracted in the browser with page numbers; key and
  model), build progress, draft preview and publish, invite link, exam screen (drawn items),
  inline checks with feedback, "review §…" steps, tutor chat bar.

## Rules for every agent

- Work only in your worktree. Commit after each numbered item when `npm test` and `npm run typecheck`
  pass. Conventional messages ending with the two attribution lines given to you. Never push.
- No secrets: never read or create `.env`, `.dev.vars`, `.admin-token`.
- Never copy the owner's real course material into the repo. Tests use small made-up text.
- No new runtime dependencies in `src/` or `worker/` without a note explaining why.
- Keep `src/` free of Node-only imports (`src/runtime.test.ts`), and `web/` importing types only.
- Keep notes in `docs/studio/notes-<A|B|C>.md`: what you did, decisions, deviations, open questions.
- Your final message: what's done, what isn't, test and typecheck status, files touched outside your area.
