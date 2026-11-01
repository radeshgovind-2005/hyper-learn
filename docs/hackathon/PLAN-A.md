# Stream A: sources, sight and the page

**Owner:** Radesh + Claude. **Goal:** the course shows what the lecture actually showed (figures, tables,
equations, the real page), citations open the original page with the source lines highlighted, and the
assessment can't be gamed. Plus the interactive widgets and the demo course.

Read first: `CLAUDE.md`, `PLAN.md` (§1 product, §2 Meta models, §4 growth rules), `JOIN.md` (contract, file
ownership, git protocol). Stream B works in parallel on the tutor; you share only the contract in `JOIN.md` §2.

## Kickoff

```
git fetch && git worktree add ../hyper-learn-a -b hackathon/a-sources origin/main
cd ../hyper-learn-a && npm install
```

Create the two contract files from `JOIN.md` §2 (exact contents) as the first commit, if they aren't there yet.
Keep `docs/hackathon/status-A.md`: one line per item, updated after each one.

## You own

`web/src/files.ts`, `web/src/passage.ts`, `web/src/components/{SourceViewer,Markdown,AssetImage,ProvenanceChip,Interventions}.tsx`,
`src/course/{compile,sources,assets}.ts`, `src/generate/**`, `src/interventions/{templates,checks}.ts`,
`src/storage/media.ts`, `src/meta/{sam,vision}.ts`, `web/src/styles/viewer.css`, `docs/hackathon/*-A.md`.
Hotspot edits go in the places listed in `JOIN.md` §3. You never edit `src/models.ts`, `src/coach/**`, `src/tutor/**`.

## You provide to stream B (see `JOIN.md` §2)

`CourseService.pageImages(learner): PageImages`, `fig:` images and the `figure(id)` callable, `Markdown.tsx`,
`ProvenanceChip.tsx`, and the `explorer` / `compare` intervention templates.

## Work items

Order matters only where "needs" says so. Items without a "needs" can run in any order, but do A2 → A3 and A7
before the rest if time is short: they are the demo.

### A1. Spikes: can Meta read our pages? (1.5 h; nothing merges)

Script `scripts/spike-a.ts` (not shipped; no key printed), your key in `.dev.vars`. Write results to
`docs/hackathon/spike-A.md` as a table of try / result / decision.

| # | Try | Pass means | Fallback |
| --- | --- | --- | --- |
| S1 | Send `ComPar-Lec01.pdf` (or any PDF) to `muse-spark-1.3` as a **file part**; ask it to list every figure and table on one page | It names the memory-hierarchy table's rows and values correctly | Render pages to PNG in the browser (A7 does this anyway) and send images |
| S2 | Send a page PNG as an **image part** with structured output (a Zod schema through `ModelProvider.structured`) | Valid JSON matching the schema | `STRUCTURED_OUTPUT_METHOD=functionCalling`; if still failing, raw `metaFetch` to `/v1/chat/completions` with `response_format` in `src/meta/vision.ts` |
| S3 | `sam-3.1` through `metaFetch` to `/v1/responses` on a page PNG with the text prompts "figure", "table", "chart" | Boxes returned and crops look right | Ask Spark for normalised bounding boxes and crop in the browser canvas |

Record **cost and latency per page** (A7 multiplies it by the page count). Decide: file part or images?

### A2. Keep the original file (3 h)

- **What:** the browser uploads the PDF's bytes, in 512 KB chunks, next to the extracted text, so the original
  can be shown later.
- **Where:** `src/storage/media.ts` (`hl_source_files(source_id, seq, bytes BLOB)`, index `(source_id, seq)`),
  `CourseService` methods after `sourcePage`: `addSourceFileChunk(id, seq, base64)`, `sourceFileChunk(learner, id, seq)`,
  callables in `worker/course-agent.ts`; `web/src/files.ts` sends the chunks after `addSource`.
- **Rules:** owner-only to write (`manage_course`); learners read only files their release cites (same check as
  `sourcePage`); caps **25 MB per file, 100 MB per course**, chunk ≤ 512 KB (message limit 1 MiB with base64);
  idempotent per `(source, seq)`; removing a source removes its chunks.
- **Grows with:** per file; paid once at upload; read by every learner (cache the assembled file in the browser, not the server).
- **Done when:** a test uploads 6 MB in chunks and reads it back byte-identical; a non-cited file is refused to a
  learner; the cap rejects the 26th MB; removing the source deletes the chunks. The UI says
  "Add the original PDF to see pages" for sources uploaded before this change.

### A3. The real page viewer (3 h) · needs A2

- **What:** clicking a citation chip shows the **actual page** with the cited lines highlighted in yellow,
  not extracted text. Previous / Next, zoom, a "Text" toggle, and falls back to today's text view when no PDF is stored.
- **Where:** `web/src/components/SourceViewer.tsx` (pdf.js `getPage` → canvas + text layer; fetch the PDF once via
  `sourceFileChunk`, keep it in memory per source); highlight by scoring text items with the existing
  `findPassage` logic in `web/src/passage.ts`; `web/src/styles/viewer.css`.
- **Done when:** clicking "ComPar-Lec01 · p.3" shows the slide with the definition lines in yellow, scrolled
  into view; moving to the next page works; a PDF-less source still shows text. Unit-test `passage.ts` on
  text items, not just lines.
- **Stretch (A10)** makes the highlight exact.

### A4. Deep links (1 h)

- **What:** `/c/<id>#<lesson>/<section>` opens that lesson and scrolls to the section; "copy link" on each
  section heading; the browser's back button works between sections.
- **Where:** `web/src/App.tsx` (read `location.hash` on load and on `hashchange`; use the existing `openSection`).
- **Done when:** the URL Radesh pasted earlier (`…#why-parallelism-and-what-parallel-machin/distributed-memory-interconnects-and-exa`) lands on that section. A small pure function `parseHash` has unit tests (missing lesson, missing section, a section that no longer exists).

### A5. Fix extraction damage; the `Markdown` component (3 h)

- **What:** the live Lesson 1 shows: a table flattened into three run-on lines, `Power ∝ C × V² × f` as plain
  text, and a list item fused with the next paragraph ("…crypto, AI Sequential programming…").
  - (a) **List then paragraph:** the splitter in `src/course/compile.ts` (`splitBlocks`) must treat a non-list
    line after a list as a new block. Add a test with the exact Lesson 1 text.
  - (b) **Equations:** the writer may emit `$…$` and `$$…$$`; code sanitises them (no raw HTML) and the UI
    renders with KaTeX (add `katex`; load lazily).
  - (c) **Tables:** the writer may emit Markdown tables; the sanitiser keeps tables, and `marked` renders them
    with an accessible style. (A7 will supply good table text from vision.)
  - (d) **`web/src/components/Markdown.tsx`:** one component that renders Markdown + KaTeX + `fig:`/`gen:`
    image refs (via `AssetImage.tsx`, which calls `figure` or `generatedImage` and shows alt text if the call
    fails). `LessonView` uses it. This is the component B's personal blocks will use at the join.
- **Done when:** tests for (a), (b), (c) pass; Lesson 1's memory-hierarchy text renders as a table; the
  equation renders; a `gen:` ref whose callable doesn't exist shows its alt text and nothing throws.

### A6. Assessment integrity (2 h)

- **What:** (a) learners' snapshots contain no answer key: strip `correct`, `misconception`, `reveals_gap_in` and
  per-option `feedback` from quiz items and check blocks in the learner view (`CourseService.snapshot` for
  learners; owners and editors keep the full one). Grading and feedback already happen on the server
  (`answerCheck`, `submitQuiz`); the preview mode in `LessonView` needs the owner's full view. (b) A
  code check in `src/generate/checks.ts` (`studioChecks`): if the correct option is the longest in more than
  60% of a lesson's checks, reject with a message the writer can act on; tell the examiner prompt to write
  distractors of similar length and specificity.
- **Closes:** `docs/engineering/scaling-audit.md` item 8.
- **Done when:** a test asserts the learner snapshot JSON contains no `"correct"` and no feedback text; owners still
  see them; a test feeds checks where the right answer is always longest and gets a rejection; the live
  Lesson 1 checks pass the new rule after a rebuild.

### A7. The "see" step: page images, vision, SAM crops, figures (6 h) · needs A1, A5

- **What:** the build looks at pages, not only their text.
  1. **Browser** (`web/src/files.ts`): for each page that likely has figures (pdf.js operator list shows
     image/path operations, or the page text is sparse), render a ≤ 1200 px PNG/JPEG and upload it
     (`addPageImage(source, page, base64)`; ≤ 150 KB each, ≤ 3 per page, ≤ 300 per course).
  2. **Build** (`src/generate/see.ts`, a new stage between *digest* and *plan*): for each page image, one Spark
     vision call with structured output: `{ figures: [{ kind: figure|table|chart|equation, caption, table_markdown?, latex?, teaches }] }`.
     Then SAM 3.1 crops each figure (`src/meta/sam.ts`) into `hl_figures(id, source, page, n, box, caption, bytes)`.
     Figure ids are assigned **by code** (`s1/p15/f1`), never by the model.
  3. **Writer** (`src/generate/write.ts`, `prompt.ts`): the writer is told which figures exist on its section's
     pages and may embed `![caption](fig:s1/p15/f1)`. Code accepts only ids that exist on that section's
     cited pages (same pattern as citation checks) and puts vision's table Markdown / LaTeX into the page
     text the writer sees, so tables and equations come out right.
  4. **Serve:** `figure(id)` callable (learner: only figures of cited files) and `CourseService.pageImages(learner)` for stream B.
  5. **Budget:** one build's vision + SAM calls count against `maxCalls` and appear in the build report.
- **Grows with:** per figure-bearing page (capped above); built once in the background; shared by all learners.
- **Done when:** with scripted fake vision and SAM, a build on a two-page fixture yields figure ids that resolve,
  a writer reference to a missing id is rejected and sent back, tables become Markdown tables, and the report
  counts the calls. On a real key (workerd smoke), rebuilding the Parallel Computing course shows the real
  memory-hierarchy slide in Lesson 1 with its caption and a chip that opens the page.
- **If vision fails (build error, quota):** the build continues text-only and says so in its warnings, as it
  already does for the fact checker.

### A8. Provenance chip (1.5 h)

- **What:** every built text block shows a small chip: its pages, and whether the fact check supported it
  ("p.15 · fact-checked ✓" or "p.15 · check doubted"). The build already gets the fact-check verdict (`review.ts`);
  store it per block as `provenance: Provenance` (type in `src/media/contracts.ts`).
- **Where:** `src/course/compile.ts` (optional field on text blocks, backward compatible), `src/generate/build.ts`
  (fill it), `web/src/components/ProvenanceChip.tsx`. It replaces the repeated "p.3 p.3" chips: one chip per block with all its pages.
- **Done when:** old snapshots without the field still load and render without a chip; new builds show it; a test covers the `doubted` case; the chip's pages open the viewer.

### A9. Interactive widgets as data, not code (4 h)

- **What:** two new intervention templates, Zod-validated JSON that the UI renders, never generated code:
  - `explorer`: a formula with named parameters and ranges (for example Amdahl's law with `N` cores and parallel
    fraction `p`), a plotted curve and a readout. Expressions are parsed by a small safe evaluator you write
    (numbers, `+ - * / ^`, parentheses, named variables, `min max log sqrt`); no `eval`, no `Function`.
  - `compare`: two cases side by side with a toggle and a one-line takeaway (for example UMA vs NUMA latency).
- **Where:** `src/interventions/templates.ts` (schemas, added to `InterventionSchema`), `checks.ts` (ranges finite,
  at most 4 parameters, formula parses and evaluates over the range without NaN or a runaway),
  `web/src/components/Interventions.tsx` (renderers), a safe evaluator in `src/interventions/expr.ts`.
- **Done when:** schema and check tests pass, including hostile formulas (`constructor`, `process`, `a.b`, huge
  exponents, division by zero); the existing three templates are unchanged; both render in the app with keyboard-accessible sliders.
- **For B:** B's `interact` tool validates with `InterventionSchema`, so it gets these for free at the join.

### A10. Quote-level citations (stretch, 2 h)

- **What:** the writer returns, per citation, an exact `quote` from the page; code checks that it appears in the
  page text (after whitespace normalisation) and drops or fixes the citation if not. The viewer highlights the
  quote exactly instead of by word overlap, and "grounded" becomes a checkable claim.
- **Done when:** a block whose quote isn't on the page is rejected in `sectionFromDraft`; the viewer highlights the exact span.

### A11. Demo course on material you may use (2 h; Radesh's own task, with Claude's help)

- The hackathon bans assets without rights. If the ComPar lectures belong to your university, don't show them
  in a public video. Choose an **openly licensed** text with figures, tables and some equations (an OpenStax
  chapter, a CC-BY lecture deck). Check the licence and write it in `docs/hackathon/pilot.md`.
- Build it as a studio course on the live site **after the join (J8)**, so it uses A7's pipeline. Until then, build a small one locally to test A7.
- Pre-build it so the video never waits on a build. Keep the old Parallel Computing course as a private fallback.

## Rules for this stream (from `CLAUDE.md`)

- `src/` stays runtime-neutral: no Node-only imports (`src/runtime.test.ts` enforces it). `web/` imports only types from `src/`.
- Every `@callable` starts with `this.actor(permission)`; add new permissions to `src/app/access.ts` and its tests.
- Every new table and list: say what it grows with and who pays (the items above do). Learners never receive answer keys or other learners' data.
- Every model call has a timeout and a budget. A failed vision or SAM call must degrade to the text-only path, never stop a build.
- Tests: scripted fake models (`src/graph.test.ts` pattern); live APIs only in the spike script.
- No secrets in the repo; keys only in your own `.dev.vars`.

## Hand-off (before the join)

`docs/hackathon/notes-A.md`: what was built, decisions, deviations, known gaps, a 60-second demo, the files you touched outside your ownership list. Then follow `JOIN.md` §5.

## Estimate

A1 1.5 · A2 3 · A3 3 · A4 1 · A5 3 · A6 2 · A7 6 · A8 1.5 · A9 4 · A11 2 = **27 h**; A10 is +2 stretch.
