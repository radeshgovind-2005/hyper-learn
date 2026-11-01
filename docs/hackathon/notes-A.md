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

Tests: 438 → 508, all passing (`npm test` now also runs `web/src/**/*.test.ts`). Typecheck and `build:web` pass.

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

1. **Studio, new course** → drop `hpc_scaling.pdf`. The file row says "Uploading the original…", then
   "Picturing pages with figures…". (Set the model key first.)
2. **Build.** The log shows *Figures: Looked at 30 page picture(s): 34 figure(s)* (Muse Spark vision + SAM 3.1).
3. **Open a lesson.** A real slide figure, cropped, with its caption; a table rendered as a table; a formula
   rendered by KaTeX. Under each block, one chip: "hpc_scaling p.12 · fact-checked ✓".
4. **Click the chip's page.** The drawer shows the **actual slide**, the quoted words outlined in yellow (or, for a
   figure, the figure's box). Previous / Next / zoom / Text.
5. **Copy link** on a section title → paste in a new tab → it lands on that section.
6. **Devtools** (as a learner): `snapshot` has no `"correct"`, no feedback; the exam neither.

## Smoke run in workerd (2026-11-01)

`wrangler dev` on :8787 from a worktree pinned to the commit under test, `--persist-to` a scratch directory,
`AUTH_DEV_BYPASS` and `KEY_ENCRYPTION_SECRET` on the command line only (`.dev.vars` untouched), the real Meta key
set through `scripts/smoke-call.mts` (read from `.env`, never printed). The browser was signed in with Clerk as an
admin; a dev learner joined with an invite.

**Course 1: `ComPar-Lec01.pdf`** (24 slides; private material, used only locally), at commit a066418 (A8):

- Upload: 879,502 bytes stored in 2 chunks; 24 page pictures (before the "≥ 60 shapes" tweak).
- Build: done in 10.6 minutes, 120 model calls. *Figures:* 24 vision calls, 12 SAM calls; 3 tables, 4 charts,
  2 figures, 3 equations. 5 lessons, 17 sections, 85 questions.
- Validation round 1 sent 9 practice questions back for giving their answer away by length (A6); one fix round
  cleared them.
- Lessons: 9 figure blocks (the p.7 trend chart, the p.11 power formula, the p.13 Xeon/i9 diagrams, the three p.15
  memory-hierarchy cards), 3 Markdown tables (one from vision's reading of p.15), 3 blocks with KaTeX.
- Found and fixed from this run: all 11 rewrites after the fact check were thrown away because one lesson's
  rewritten checks broke the length rule, so 50 of 76 blocks showed "check doubted" (fixed in c89fc73: only the
  offending rewrites are undone). The figure crop of a tall card filled the screen (capped), the yellow highlight
  was invisible on dark slides (`multiply`), a figure block's chip highlighted a guess (it now outlines the
  figure's box), and the fallback highlight ignored numbers (fixed). All checked again in the browser.
- As a learner (dev user who joined with an invite): `snapshot` 213 KB with no `"correct"` and no `"feedback"`
  (the owner's copy has both); `exam` has no `"correct"`; `figure` and `sourceFileChunk` work for the cited file;
  `addPageImage` is refused ("Your role in this course (learner) can't do that").
- Deep link `/c/<id>#applications-and-parallel-hardware-platf/multicore-cpu-gpu-and-cluster-memory-hie` landed on
  the section.

**Course 2: `hpc_scaling.pdf`** (56 slides, CC BY 4.0; the demo material), at the latest commit:

- Upload: 2,546,786 bytes in 5 chunks; 30 of 56 pages pictured.
- Build (after one restart: `wrangler dev` was stopped mid-build by a tool time limit, and the build was correctly
  marked "interrupted, build again"): done in 15.3 minutes, 183 model calls. *Figures:* 30 page pictures, 34 figures.
  6 lessons, 27 sections, 110 questions. Validation round 1 had 2 problems, fixed in one round.
- Lessons: 22 figure blocks (e.g. the 2D processor-grid diagram of p.36), 6 tables, 64 blocks with formulas
  (α + βn + γm, Amdahl's law), all rendered.
- **Quotes (A10): 107 of 115 text blocks carry a quote checked against its page**; 12 quotes were not on their page
  and were left out (logged per section). Opening a chip highlights exactly the quoted line on the real slide.
- **Fact check: 101 blocks "fact-checked ✓", 14 "check doubted"** (two sections the checker still doubted after a
  rewrite; warned in the build). The ComPar run before the revert fix was 26 ✓ / 50 doubted.
- Found and fixed from this run: LaTeX-made PDFs give a text item per glyph, so a quote was a row of small boxes
  (joined per line now); a chip's pages are sorted ("p.35, 36").
- Closing: a socket without a token, and one with a bad token, get 401. The scratch state was deleted.

Quality notes for J8 (content, not code): on diagram-heavy slides some blocks describe the picture literally
("The display shows x0 with a00 a01 a02 y0"), and vision sometimes crops a slide's formula as a figure next to a
KaTeX block saying the same. Worth a look in the owner's review before publishing; prompt tuning if it recurs.

## Cost

Both builds ran on Radesh's key: ~300 model calls (54 of them vision, ~35 SAM). At the spike's per-call costs that is
roughly $2–4 in all; check the Meta dashboard for the exact figure.
