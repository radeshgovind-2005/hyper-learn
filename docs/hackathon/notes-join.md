# The join: streams A and B as one product

Branch `hackathon/integration` from `origin/main` (a19dde7), 2026-11-01. Stream A (#15) merged first, then
stream B (#16). `npm run typecheck`, `npm test` (554 tests: 508 from main + A, 33 from B, 13 new in
`src/app/join.test.ts`) and `npm run build:web` pass.

## J1–J3: merges

- **J1, stream A:** no conflicts. 508 tests pass.
- **J2, stream B:** two conflicts, as the dry run said.
  - `web/src/types.ts`: both blocks kept; `Provenance` is exported once (from A's block).
  - `src/app/service.ts`: both fields and both constructor lines kept, with B's `tutor.failRunning(...)`. In the
    owner-key area A's split stands: `ownerKey()` now also returns the chosen model's endpoint (`baseURL`:
    `owner.endpoints[model] ?? owner.config.baseURL`) and `onMeta` (no endpoint of its own). Everything that
    builds a client with the owner's key uses it: `ownerProvider()` (text), `pageSeer()` (vision), and
    `metaConfig()` (images and voice, which B had written as a second copy of the key opening).
  - **Which models stay on Meta's host:** SAM 3.1, Muse Image and Voice Transcribe exist only on Meta's API, and
    an open-weights course's key is for its own endpoint. So: vision goes to the course model's endpoint (it is
    that model reading the page); SAM runs only when `onMeta` (otherwise the build keeps Spark's boxes, which
    `see.ts` already does when `segment` is absent); images and voice refuse with "need a Meta model key", as B
    decided. Whether the open model can read page pictures is untested (no Baseten key; J9).
  - Semantic conflict found by the typecheck: the tutor's `sectionText` had no case for A's `explorer` and
    `compare`; added. `package-lock.json` didn't conflict.
- **J3:** `src/media/contracts.ts` and `src/meta/client.ts` are the same blobs on both branches (52b5aa4,
  8127e46). Nothing to do.

## J4: the seams

| Seam | Done | How | Test (`join.test.ts`) |
| --- | --- | --- | --- |
| a. tutor sees page pictures | yes | the tutor's default is `service.pageImages(learner)` | `look_at_page` hands the model the stored JPEG |
| b. personal blocks use `Markdown` | yes | `PersonalLayer` renders text pieces with A's `Markdown` (KaTeX, `fig:`/`gen:`); `PersonalMarkdown` is gone | (UI; typecheck and build) |
| c. `ProvenanceChip` on personal blocks | yes | one chip per card from the block's `provenance` ("Made for you", pages, verdict), plus the "because…" sentence | (UI) |
| d. `gen:` refs in the sanitiser | not needed | no path writes `gen:` into Markdown: image pieces carry ids, and the writer is only ever offered `fig:` ids. A `gen:` id is a valid `ASSET_REF` if that changes | a `gen:` image is served to its learner only |
| e. `interact` takes `explorer`/`compare` | yes | B's `widgetProblems` also runs A's `widgetProblems` (ranges, formula parses and stays finite, compare labels and numbers); the tool's description lists both | valid explorer accepted; 4 malformed and 5 hostile specs refused |
| f. access matrix | yes | every new callable starts with `this.actor(...)`: `figure`, `pageImage`, `sourceFileChunk`, `generatedImage`, `tutorTurn`, `answerCoachCheck` → `learn`; `promoteRepair` → `repair`; `tutorSuggestions` → `view_learners`. The matrix (`access.ts`) needed no new permission | parses `worker/course-agent.ts`: all 71 callables start with `this.actor(`, and the new ones have these permissions |
| g. `coachState()` keys | yes | `coachState(learner, view)`: questions through `learnerItem` (the course's salt), the personal lesson's practice check without `correct`/`feedback`; `submitDiagnosis`/`submitRecheck` map answers back from the view; new callable `answerCoachCheck` grades the check. The worker sets `view` for people without `repair`, as A does for `snapshot` and `exam` | the JSON has no `"correct"` or `"feedback"` before and after a diagnosis and repair; grading on the view still works |
| h. Coach and EditPanel use `Markdown` | yes | both, with `call` so figures load | (UI) |
| i. figures for edits and coach lessons | yes | `RepairInput.figuresOn` and `EditContext.figuresOn` (one query per page of the section); the service passes them to coach repairs, tutor rewrites and edits | a tutor rewrite shows a `fig:` that resolves; an edit keeps its figure |

Also tested: the endpoint rule from J2 (Meta model: vision at Meta, with SAM; open-weights model: vision at its
endpoint, no SAM, `metaConfig` refuses). Each J5 test was checked against its seam: with the wiring removed
(page images, `figuresOn`, A's widget checks, the coach view), the matching test fails.

## J6: smoke run in workerd (2026-11-01)

`wrangler dev --port 8799` from a separate worktree pinned to 3c309a7, `--persist-to` a scratch directory,
`--var AUTH_DEV_BYPASS:true --var KEY_ENCRYPTION_SECRET:<random> --var TUTOR_VERIFIER:on` on the command line
only (no `.dev.vars` in that worktree; the original's untouched). The real Meta key was read from `.env` by
`scripts/join-smoke.mts` and never printed. Afterwards the server was stopped and the scratch state and the
worktree deleted.

**Material:** 8 slides of Eijkhout's `hpc_scaling.pdf` (CC BY 4.0; slides 7, 9, 17–20, 35, 36: the α/β/γ
model, broadcast, speedup and efficiency, Amdahl, 2D partitioning), used locally only.

**What stood in for the browser:** the browser normally extracts page text with pdf.js and renders page
pictures. Here `pdftotext` gave the text and `pdftoppm` the pictures (1200 px wide JPEGs, 33–93 KB), sent
through the same callables (`addSource`, `addSourceFileChunk`, `addPageImage`). So the server path was tested,
not `web/src/files.ts`.

Step by step (JOIN.md §7):

1. **Upload and the "see" stage: passed.** Original 152,844 bytes in 1 chunk, 8 page pictures. Build log:
   *Looked at 8 page picture(s): 12 figure(s) — 8 vision call(s) (Muse Spark), 12 segmentation call(s) (SAM
   3.1). Found 2 table(s), 1 figure(s), 9 equation(s).* Build done in 10.3 min, 75 model calls: 4 lessons, 13
   sections, 60 questions. Validation round 1 sent 2 problems back; one fix round cleared them.
2. **Figures, tables, equations: partly.** 57 text blocks: 19 show a figure (12 distinct `fig:` ids, all
   equations or diagrams cropped from slides), 27 have formulas, **0 are Markdown tables**, although vision read
   2 tables. Rendering (KaTeX, the crops) was not looked at: no browser (see below).
3. **Chip opens the original page: server side only.** Every text block has provenance (55 "supported", 2
   "doubted": the title-only slide 17, "Efficiency and scaling", which the fact checker rightly doubted); 51
   carry a quote checked against its page. As a learner: `citedSources` lists the file with its original,
   `figure(s1/p1/f1)`, `pageImage(s1, 1)` (JPEG) and `sourceFileChunk(s1, 0)` (starts `%PDF-`) work;
   `addPageImage` is refused. The yellow highlight in the viewer was not seen.
4. **Deep link: not checked** (needs the browser). Section ids exist (`#speedup-sp-and-efficiency-ep/...`).
5. **Voice: passed through workerd** with a `say`-generated 16 kHz recording of "I don't get why adding more
   processors stops helping": partial words while sending, final transcript *"I don't get why adding more
   processors stops helping.."* 249 ms after the end. Voice socket without a token: 401. The microphone and
   AudioWorklet in a real browser were not tested.
6. **Diagnostic question first: passed.** 5.3 s, 1 model call; Muse asked one question (a lab report claiming
   Sp = 12 on 6 processors). Caveat: the script picked the last option meaning to answer wrongly, and it was the
   right one (`{"correct":true}`), so this run didn't exercise a wrong answer.
7. **Rewrite with the cropped figure, a Muse Image diagram, an explorer: passed.** After the answer, one turn
   (30.7 s, 2 model calls) went to the section and started a rewrite, a diagram and a `compare` widget. The
   rewrite (worked example) was ready in about 2 minutes and shows `fig:s1/p4/f1` and `fig:s1/p4/f2` (the
   speedup and efficiency formulas cropped from slide 18), both fetchable by the learner: **J4i in the real
   loop**. A request for "sliders for the parallel fraction and the number of processors" made Muse build an
   **`explorer`** that passed A's checks (48.6 s, 4 model calls). Muse Image drew two diagrams (webp); another
   learner's `generatedImage` for one of them: refused ("No such picture").
8. **"Made for you" and provenance: passed (data).** Rewrites carry `{pages: [s1 p.4], fact_check: "supported",
   made_for: "you said …"}` (with Muse Wonder on); diagrams and widgets are "unchecked". The chip itself wasn't
   seen in a browser.
9. **Two more learners fixed by the same approach: passed.** Three learners pressed "Explain differently" then
   "Quiz me on this" on one section and answered right. The first rewrite took 63 s; the next two were the
   shared one (0 s, no model call). Insights: *4 learners · fixed 3/3 · promote smaller_steps (3/3)*.
10. **Promote, approve, keep or revert: passed, as an edit, not a trial.** `promoteRepair` gave a ready
    proposal in 60 s (archive 3 blocks, insert the smaller-steps version); `applyEdit` → v1.1.0; `undoRelease`
    → v1.2.0. As B decided, promotion goes through the owner-edit path (validated, risk-tiered, undoable), which
    does not run a trial; JOIN.md's wording "the harness trials it" is not what happens. Weak spot: the promoted
    section was the title-only slide, so its "rewrite" is one line ("Efficiency and scaling."). The demo should
    promote on a real section.
11. **Open-weights run: not done** (no Baseten key; J9).
12. **No answer key: passed.** As a learner: `snapshot` (100 KB) has no `"correct"` and no `"feedback"`;
    `exam` has none; `coachState` after `startDiagnosis` (3 questions) has none; `personalBlocks` none; no tutor
    turn result contained `"correct"`. The owner's snapshot has keys, as intended. (`answerAsk` returns
    `{"correct": true}` about the learner's own answer, which is not a key.)

Closing: a course socket without a token, and one with a bad token, get 401.

**Not checked, needs a person in a browser** (Clerk sign-in can't be done by an agent, and the web app has no
dev-bypass path): the page viewer and its highlight, KaTeX and figure rendering, deep links landing, the dock's
look and streaming in the real shell, the mic, the "Promote" button in Studio, the coach page on the learner view
(`answerCoachCheck` from the UI).

**Cost:** roughly 110 Meta calls on Radesh's key (75 for the build, the rest tutor turns, 5 personal rewrites
with Wonder checks, 2 images, 1 edit, 1 transcription). Check the dashboard for the figure.

## What the human still does

- Read the diff, then push `hackathon/integration` and open its PR (J7 needs a yes first).
- J7: merge to `main` (deploys); check the live site with the first four acceptance steps, in a browser.
- J8: rebuild the demo course live (the owner's Meta key in Studio; the CC BY slides, `pilot.md`).
- J9: the open-weights run with a Baseten key.
- J10: the pilot. J12: video and submission.
- The browser checks listed above, once, before recording.
