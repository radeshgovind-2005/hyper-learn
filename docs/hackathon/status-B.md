# Stream B status

One line per item: `todo | doing | done | cut`, the commit, and what stream A / the join can use now.
Branch `hackathon/b-tutor` (pushed). Details, deviations and the demo are in `notes-B.md`.

| Item | Status | Commit | For stream A / the join |
| --- | --- | --- | --- |
| Contract files (`src/media/contracts.ts`, `src/meta/client.ts`) | done | `cde9198` | Byte-identical to stream A's (copied from `hackathon/a-sources`) |
| B0 spikes | done | `e3b5744` | `spike-B.md`: image, voice, tool loop, streaming all pass; S7 (Baseten) not run, no key |
| B1 tutor core | done | `beebf84`, `c4a5cf9` | `CourseService.tutorTurn`; the tutor takes `TutorOptions.pageImages(learner)`, default `noPageImages` (J4a: pass `service.pageImages(learner)`) |
| B2 dock | done | `c72313c`, `dbe3ac1` | `TutorDock` mounted in `App.tsx` before `</Shell>`; performs `go_to_section` and `open_source` (calls the existing `openSource`) |
| B3 personal layer | done | `beebf84`, `c72313c` | `PersonalLayer` via `LessonView`'s new `sectionFooter` prop; blocks carry `Provenance` (J4c: render `ProvenanceChip`); private `PersonalMarkdown` (J4b: swap to A's `Markdown`) |
| B4 voice | done | `beebf84`, `74ebbf9` | `/agents/voice` (worker/voice.ts, one line in worker/index.ts); verified through workerd with real audio |
| B5 Muse Image + storyboard | done | `beebf84`, `c72313c` | `gen:` ids served by callable `generatedImage(id)` (learn); pieces name the image id (J4d) |
| B6 bandit, suggestions, promotion | done | `beebf84` | `coachInsights` rows gain `promote`; callable `promoteRepair` (repair); `tutorSuggestions` (view_learners) |
| B7 open-weights switch | done (not run live) | `beebf84` | `OPEN_WEIGHTS_BASE_URL` / `OPEN_WEIGHTS_MODEL` add a choice with its own endpoint; needs a Baseten key for J9 |
| B8 Wonder verifier (stretch) | done | `beebf84`, this branch | `TUTOR_VERIFIER=on`; verified live against `muse-wonder-1.0` |
| `interact` with A's `explorer` / `compare` | ready | | Validates with `InterventionSchema` as it stands: A's new templates are accepted once A adds them to the schema (J4e) |
