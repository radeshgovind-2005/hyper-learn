# Stream A hand-off: sources, sight and the page

Branch `hackathon/a-sources`, draft PR #15. Every item in `PLAN-A.md` is done, A10 (stretch) included;
A11's material is chosen and licensed, and its live build is the join's J8. Per-item commits are in
`status-A.md`.

## What was built

| Item | What a person sees | Where |
| --- | --- | --- |
| A1 | `spike-A.md`: Spark reads page images with a strict JSON schema; SAM 3.1 needs a concrete noun | `scripts/spike-a.ts` |
| A2 | PDFs keep their original next to their text; "Add the original PDF to see pages" on older ones | `src/storage/media.ts`, `CourseService.addSourceFileChunk` and friends, `web/src/files.ts` |
| A3 | A citation opens the **real page** with the cited words in yellow; Previous/Next, zoom, a Text toggle | `web/src/components/SourceViewer.tsx`, `web/src/passage.ts` |
| A4 | `/c/<id>#<lesson>/<section>` lands on the section; Back works; "Copy link" under each section title | `web/src/deeplink.ts`, `web/src/App.tsx`, `CopyLink.tsx` |
| A5 | Tables render as tables, formulas with KaTeX, lists no longer swallow the next paragraph | `src/course/compile.ts` (`splitBlocks`), `src/generate/write.ts` (sanitiser), `web/src/components/Markdown.tsx`, `web/src/markdown.ts` |
| A6 | Learners' browsers never get answer keys; questions whose right answer is the longest option are sent back | `src/assessment/view.ts`, `CourseService.learnerSnapshot`, `exam(…, view)`, `submitQuiz(…, view)`; `src/generate/checks.ts` |
| A7 | The build log has a "see" step (Spark vision + SAM); lessons show real figures cropped from the slides; tables and equations come from the page picture | `src/generate/see.ts`, `src/meta/vision.ts`, `src/meta/sam.ts`, `web/src/files.ts` (`uploadPageImages`), `AssetImage.tsx` |
| A8 | One chip per built block: "Lec01 p.3, 4 · fact-checked ✓" (or "check doubted"); its pages open the viewer | `src/generate/assemble.ts` (`stampProvenance`), `ProvenanceChip.tsx` |
| A9 | Two widget templates: `explorer` (formula, sliders, curve, readout; e.g. Amdahl) and `compare` (two cases, toggle, bars) | `src/interventions/{templates,checks,expr}.ts`, `web/src/expr.ts`, `Interventions.tsx` |
| A10 | Each citation carries a quote checked against its page; the viewer highlights exactly that quote | `src/generate/write.ts` (`findQuote`), `web/src/passage.ts` |
| A11 | Demo material: Eijkhout's *Art of HPC* slides, CC BY 4.0, attribution line ready | `pilot.md` |

Tests: 438 → 505, all passing (`npm test` now also runs `web/src/**/*.test.ts`). Typecheck and `build:web` pass.

## For stream B, at the join

- **`<Markdown markdown call />`** (`web/src/components/Markdown.tsx`): use it for personal blocks instead of
  `PersonalMarkdown`. It draws `fig:` and `gen:` pictures; for `gen:` it calls `generatedImage(id)` and accepts
  `{ mime, base64 }` or `{ url }`; on any failure it shows the alt text.
- **`CourseService.pageImages(learner): PageImages`**: pass it to the tutor instead of `noPageImages`. It returns
  null for pages without a picture and for files the learner's release doesn't cite.
- **`ProvenanceChip`** takes a `Provenance` (`made_for` shows "Made for you"), the cited-sources map and an
  `open(source, page)`.
- **Figures in personal blocks**: the sanitiser keeps a `fig:`/`gen:` picture only when the caller's check accepts
  it: `sanitizeMarkdown(text, (ref) => …)`, or `sectionFromDraft(draft, section, figures)`, which accepts the figures of
  the section's pages. Figures of a page: `SqlMedia.figuresOn(source, page)` (not yet exposed by `CourseService`;
  add a getter beside `figure()` if the tutor needs a list).
- **Widgets**: `InterventionSchema` now accepts `explorer` and `compare`. Schema-valid isn't enough for an
  explorer: also run `widgetProblems(intervention)` from `src/interventions/checks.ts` (ranges, the formula parses,
  stays finite). `checkIntervention` already does.
- **Answer keys**: `coachState()` (src/coach, yours) still sends quiz items with keys. `learnerItem(item, salt)`
  in `src/assessment/view.ts` makes the learner's copy. The salt is `CourseService`'s (`itemSalt()`, private):
  either make it a public method or, for diagnosis items, which aren't graded in a shuffled order, use `learnerItem`
  with any salt on single/multi/two-tier items. The tutor's answers must not include keys either (J5 test 6).
- Deep links for `go_to_section`: `hashOf(lesson, section)` in `web/src/deeplink.ts`; App follows the hash.

## Decisions and deviations from the plan

1. **Bytes as base64 text, not BLOB** (`hl_source_files.data`, `hl_page_images.data`). They arrive and leave as
   base64; the Worker never needs raw bytes, and the `Sql` type has no blob value. Costs a third more storage:
   100 MB of originals is about 133 MB of SQLite, far under 10 GB.
2. **A figure is a box on its page picture, not a cropped image** (`hl_figures` keeps the box, as fractions of the
   picture). The browser shows the crop by scaling the page picture in a clipped frame (`AssetImage`). No image
   decoding in the Worker, and storage is paid once per page. `figure(id)` returns the box and caption;
   `pageImage(source, page)` returns the picture.
3. **One picture per page**, not up to three: the cap is 300 per course, ≤ 150 KB each.
4. **SAM refines, Spark locates.** SAM 3.1 returns nothing for "figure"/"table" on slides (spike S3), so Spark
   gives each figure a box and a concrete `sam_prompt`; the crop is the SAM box overlapping Spark's (IoU ≥ 0.3)
   joined with Spark's, else Spark's alone.
5. **Vision goes through `metaFetch`, not `ModelProvider`** (stream B's `src/models.ts`), with strict JSON schema,
   `reasoning_effort: "low"`, 60 s timeout, 2 retries. Its instruction lives in `src/meta/vision.ts`; there is no
   `figure_reader` agent in `agents.json`.
6. **A6 covers ordering, matching and Parsons too**: removing `correct` isn't enough where the order is the
   answer, so those are shuffled by a secret per-course salt and mapped back before grading. `submitQuiz` and
   `exam` take a trailing `view` flag; the worker sets it for people without `repair`. Tests and the CLI are
   unchanged (no flag, authored order).
7. **A10 drops a quote that isn't on its page instead of rejecting the block.** PDF text is noisy (ligatures,
   hyphenation); a rejected block costs a fix round, and three failed rounds fail the build. Matching ignores
   case, punctuation and spacing. Every stored quote is on its page; blocks without one fall back to the
   word-overlap highlight.
8. **Page pictures in slide decks**: every slide draws shapes, so the browser's "has a figure" test (images, ≥ 60
   path operations, or under 200 characters of text) still selects most slides. Vision returns nothing for a
   text-only slide; a 24-slide deck costs about $0.10–0.25 to read.
9. **Interventions keep their own keys.** `practice`/`contrast` check questions are unscored and checked in the
   browser, so learner snapshots strip keys from quiz items and section checks only.

## Known gaps

- `coachState()` still sends keys (stream B's file; see above).
- Coach and edit-proposal pages (`Coach.tsx`, `EditPanel.tsx`) still render with plain `marked`, so formulas show
  as TeX there. Switch them to `Markdown` at the join (B owns Coach's content).
- Edits (`src/edit`) and coach lessons call the writer without figures, so a block rewritten by an edit loses a
  `fig:` picture it had. Pass `figuresOn` for the section's pages there.
- No per-user quota on uploads beyond the per-course caps; an owner can re-upload the same pages repeatedly
  (idempotent, bounded by the caps).
- The length rule (A6) and quotes (A10) are new pressure on the writer: watch the first live builds' fix rounds.

## Files touched outside A's ownership list

See the list at the end of `status-A.md`. In short: `src/app/service.ts` and `worker/course-agent.ts` (in the
places `JOIN.md` §3 gives A, plus the `view` flag on `snapshot`, `exam`, `submitQuiz`); `web/src/App.tsx` (hash
links, `sectionTools`); `web/src/components/LessonView.tsx` (`BlockView`, `CheckView`, `TEMPLATE_NAME`);
`web/src/pages/Studio.tsx` (uploads); `src/app/courses.ts` and `worker/builder.ts` (`BuildExtras`);
`src/generate/types.ts`; `src/config/agents.json` (writer only); `src/releases/changes.ts` and
`src/simulation/learners.ts` (names and efficacy for the two new templates); `src/assessment/view.ts` (new);
`package.json` (`katex`, test glob); `docs/engineering/scaling-audit.md` (item 8).

## The 60-second demo

(Filled in after the workerd smoke run below.)

## Smoke run in workerd

(Filled in below.)
