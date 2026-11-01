# Stream A status

One line per item: `todo | doing | done | cut`, the commit, and what stream B can use now.

| Item | Status | Commit | For stream B |
| --- | --- | --- | --- |
| Contract files (`src/media/contracts.ts`, `src/meta/client.ts`) | done | (this commit) | Byte-identical to `JOIN.md` §2 |
| A1 spikes | done | 80ee1c0 | `spike-A.md`: Spark reads page images with strict JSON schema; SAM 3.1 needs a concrete noun ("chart"), not "figure"/"table" |
| A2 original file | done | 80ef0dd | `CitedSource.file` (optional) says whether the original PDF is stored; `sourceFileChunk(id, seq)` |
| A3 page viewer | done | c377c57 | `SourceViewer` shows the real page; same `SourceTarget` as before |
| A4 deep links | done | abd6b64 | `#<lesson>/<section>` = the section id; `web/src/deeplink.ts` (`hashOf`, `parseHash`) for the dock's `go_to_section` |
| A5 extraction damage, `Markdown.tsx` | done | ce8c34e | **`<Markdown markdown call />`** is ready for personal blocks (tables, KaTeX, `fig:`/`gen:` via `AssetImage`, raw HTML shown as text). `gen:` calls `generatedImage(id)` and accepts `{ mime, base64 }` or `{ url }` |
| A6 assessment integrity | done | fd4342c | Learners get `learnerSnapshot` / `exam(…, view)`: no keys; ordering/matching/Parsons shuffled by a per-course salt and mapped back in `submitQuiz(…, view)`. **`coachState()` still sends keys** (src/coach is B's): use `learnerItem` from `src/assessment/view.ts` there |
| A7 "see" step, figures | done | d673802 | **`CourseService.pageImages(learner)`** is the `PageImages` for the tutor; `figure(id)` / `pageImage(source, page)` callables; figures are `fig:s1/p15/f1` boxes on page pictures |
| A8 provenance chip | done | a066418 | **`<ProvenanceChip provenance sources open />`**; `made_for` shows "Made for you" |
| A9 `explorer` / `compare` widgets | done | 1c34090 | `InterventionSchema` accepts both; also run `widgetProblems()` (src/interventions/checks.ts) before accepting one |
| A10 quote-level citations (stretch) | done | 152fb9a | `SectionDraftSchema` cites now carry `quote` (nullable); your writer calls get it for free |
| A11 demo course | done (material); live build is J8 | 8e61d62 | `pilot.md`: Eijkhout's *Art of HPC* slides, CC BY 4.0 |

## Shared files edited (outside A's list)

- `web/src/pages/Studio.tsx`: upload the original PDF after its text; "Add the original PDF" per old source; pass `file` to the viewer.
- `web/src/App.tsx`: hash deep links (near the lesson logic, as `JOIN.md` §3 says) and `CopyLink` in `sectionTools`.
- `web/src/components/LessonView.tsx`: `BlockView` renders with `Markdown`; `CheckView` copes with checks without a key.
- `src/app/service.ts`: `media` field; methods after `sourcePage`; `learnerSnapshot`, `exam(…, view)`, `submitQuiz(…, view)` (one optional trailing argument each).
- `worker/course-agent.ts`: callables after `sourcePage`; `snapshot`, `exam`, `submitQuiz` serve the learner view to people without `repair`.
- `src/config/agents.json`: the writer's instructions (formulas, tables, figures).
- `src/assessment/view.ts` (new), `src/assessment/view.test.ts` (new).
- `package.json`: `katex`; `npm test` also runs `web/src/**/*.test.ts`.
- `docs/engineering/scaling-audit.md`: item 8 marked fixed for `snapshot()`/`exam()`.
- `src/app/courses.ts`, `worker/builder.ts`: `CourseBuilder` takes an optional 4th argument, `BuildExtras` (`seer`).
- `src/generate/types.ts`: build stage `"see"`; `BuildResult.figures`.
- `src/course/compile.ts` (A's): `TextBlock.provenance`, `TextBlock.quotes` (optional).
- `src/interventions/templates.ts` (A's): two templates; `src/releases/changes.ts` and `src/simulation/learners.ts`: their names and default efficacy.
- `src/generate/schemas.ts` (A's): `SectionDraftSchema` cites have `quote`.

## Ready to join (JOIN.md §5), 2026-11-01

- [x] Every non-stretch item done; A10 (stretch) done too. A11: material chosen and licensed; its live build is J8.
- [x] `npm run typecheck`, `npm test` (508 pass) and `npm run build:web` pass; CI green on PR #15.
- [x] Hand-off note: `notes-A.md`.
- [x] Runs in workerd with studio courses and a real key; the 60-second demo works (`notes-A.md`, "Smoke run").
- [x] No secret in the diff: the grep finds only variable names and the tests' fake keys.
- [x] Degrades without stream B: `PageImages` unused until the join; no `gen:` image renders as its alt text.
