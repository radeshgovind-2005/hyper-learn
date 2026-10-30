# Wave 1 integration: notes

Branch `studio/integration`, off `studio/base`. Merged in order: `studio/assessment`, `studio/platform`,
`fix/stuck-run` (PR #10 against `main`), `studio/generate`. 390 tests, typecheck passes.

## Merges

- `src/app/service.ts` was the only conflict (A against C). A's imports and its `progress()` over the
  served release's lessons, plus C's course definitions. `sql.ts` merged on its own. `generate` merged cleanly.
- The constructor runs both restart recoveries: a build left `building` fails; a run left `running` is
  ended by `recoverInterruptedRun` (fix/stuck-run).
- A's learner-exam tests now hold the studio fixture as a real `CourseDefinition` instead of resetting
  the featured course's releases to it.

## Wiring

- `worker/builder.ts`: `courseBuilder` is `generateCourse` with the owner's `StructuredFactory`.
- New callables on `CourseAgent` [learn]: `exam(lesson)`, `answerCheck(blockId, option)`; `submitQuiz` takes
  `item_ids` as a fourth argument. The web app doesn't call them yet (wave 2 E).
- Callable arguments are checked in the service (known issue 4): `beginRun` parses run options (mode,
  agents, source); `parseApproval` refuses `approved: "false"` and runs before an approval is claimed;
  `submitQuiz` checks that answers, certainty (1–3) and item_ids are lists.

## Changes to the workstreams' decisions

- **Two questions per objective** (`BuildOptions.perObjective` default 2), decided with the user: with one,
  a lesson exam has 2–3 questions and one slip fails it. The pool is 5 per objective.
- **One examiner call per objective** so each answer stays short (up to 25 questions per lesson otherwise).
  The first call writes the misconceptions; the others are given them. `mergeDrafts` joins the drafts;
  `problemsByPart` sends each problem to the call that wrote the question, renumbered as that call saw it.
  New misconceptions re-ask every call of the lesson, since their tags would be stale.
- **An objective can't be missed in a passed exam.** `gradeAttempt` gives partial credit (half a
  multi-select, most of an ordering), so both questions of an objective could be wrong and the mean still
  reach 0.75. For items with objectives, passing now also needs one fully right answer per objective
  shown. Lessons without objectives grade as before; A's simulations and B's stress test are unchanged.
- **Real trials number attempts within the trial** (known issue 2, also on `main`). Answers store an
  all-time attempt number, so `persistence` (first try vs retake) skipped anyone who had taken the quiz
  before the trial started. `measureReal` now counts attempts from the trial's start (`attemptsFrom(…,
  { renumber: true })`); diagnosis still uses all-time first attempts.
- **`studioChecks` keeps only generation's own rules** (item types, citations, copying). Objective and
  check-block rules come from A's validator, so problems are no longer reported twice.

## Tests added

- `src/app/studio-flow.test.ts`: a studio course built with the real generator (canned models), published,
  then a learner: two questions per objective, one slip passes, a missed objective fails and gives a
  `review_section` step, the retake draws unseen questions, a stale draw is refused, checks give feedback
  and are recorded on the served release.
- `src/generate/generate.test.ts`: merging per-objective drafts and routing problems by part.
- `src/app/service.test.ts`: callable argument checks, and the restart recoveries (from fix/stuck-run).

## Still open

- Real dry run (2026-10-30, `muse-spark-1.3`, two lectures + one test): built 6 lessons, 18 sections,
  115 questions in 76 calls, about 20 minutes. Fixed from it: the right answer was option 1 in 44 of 46
  single-choice questions (options are now shuffled in code); practice options over 200 characters (the
  limits are now in the writer prompt and schema); 3 of 23 objectives taught only by the test, not the
  lectures (the planner is now told assessments set emphasis, not content); one failed call ended the
  build (now retried with growing waits). Re-run with the fixes: 120 questions in 80 calls, the right
  answer spread over all positions, no rejected practice question, no objective from the test alone, no
  fact-check warning. Still to look at: the right answer is the longest option in 34 of 48 (the prompt
  alone didn't fix it); the stress test says every question of a lesson reveals the gap; practice
  feedback sometimes says "the pages say", which learners don't see.
- Smoke-tested in local workerd: a studio course built by the Worker with Muse Spark on the owner's key
  (4 lessons, 60 questions, 2 minutes), published, exam drawn, check answered.
- One lesson that doesn't converge in 3 rounds fails the whole build.
- `exam()` and `snapshot()` send answer keys to the browser (as on `main`).
- Short answers are still stored `needs_review` (known issue 3); generated pools have none.
- Activity rate limit per connection (known issue 5) and the Assistant's `getCourse()` tools (issue 6).

## Sources, delete, audience

Branch `studio/sources`, off `main` after the Studio UI (PR #12).

**Learners open the pages lessons cite.** `citedSources(learner)` lists the files cited by a live block
(live lesson, section and block) of the release the learner is served, so during a real trial the two arms
can differ. It leaves out files the owner hid, and never lists a file whose role is `assessment` or `brief`,
even if a block cites one: they show what is assessed and may hold the answers. A file whose role was left
to the build is shown if cited (the planner only cites teaching material). `sourcePage(learner, id, page)`
opens any page of a listed file, not only the cited ones, and refuses anything else with "This file isn't
shared with learners". Built-in courses have no sources: `[]`, and `sourcePage` refuses. The owner's
`ownerSourcePage` opens any page of any file, draft or published. `setSourceShared(id, shared)` keeps the
hidden ids in meta (`hidden_sources`), not a new column, and works after publishing (it changes who may read
a file, not what lessons say). `sourceList` (and the summaries addSource, appendPages and setSourceRole
return) carry `shared`. Callables: `citedSources`, `sourcePage` [learn]; `ownerSourcePage`,
`setSourceShared` [manage_course]. `setSourceShared` doesn't push state: sources aren't in the overview, and
learners fetch `citedSources` when they open the course (or their served release changes).

UI: chips "Lecture-01 · p.3" after each cited text block, only for files the reader may open; the owner's
draft preview shows chips for every file. A chip opens the "source" drawer: "Page N of M", Previous/Next,
and the passage that best matches the block highlighted. The match (`web/src/passage.ts`) is a word-overlap
heuristic: pieces are lines (long lines are cut into sentences), scored by shared lowercase words of 4+
letters; the best piece needs 2 shared words, and grows to at most 3 pieces with neighbours scoring at least
half as well. It finds the right lines on clean text; on PDF text with broken lines it may highlight a
neighbour. The studio's file list has "View" and a "Learners can open" switch (none for exams and briefs).

**Owners delete a course.** `DirectoryAgent.deleteCourse(id)`: the owner as the directory's memberships
record it, or a global admin; built-in courses can't be. The course object's `wipe()` (RPC, not callable)
closes every connection with 4004 "This course was deleted", then calls the Agents SDK's `destroy()`: it
cancels the SDK's schedules and alarm, deletes all storage (`ctx.storage.deleteAll`) and resets the object.
Calling `deleteAll` ourselves would leave the hourly trial check scheduled. `destroy()` aborts the isolate
right after returning, so the directory may see the RPC fail although the wipe worked; it then keeps the
course listed and says "try again", and a second wipe of the now empty object is harmless. Only after a
successful wipe does the directory forget the course and every membership, after which the Worker refuses
to route to it (404), so it isn't recreated. Not smoke-tested in workerd (that needs `.dev.vars` changes);
worth one run before the demo. The 20-course limit message now points at the delete card.

**Audience.** `StudioRecord.audience` (`beginner | intermediate | advanced`; `record()` reads old records
without it as beginner). Set at creation (`CourseDetailsSchema`, default beginner; the directory hands it to
`initialise` and doesn't store it), changed with `updateDetails`, returned by `details()`. Builds always pass
it in `BuildInput.audience`. `audienceLine()` in `src/generate/prompt.ts` adds one line to the planner,
writer and examiner prompts; without an audience (the CLI has no flag yet) it is empty and the prompts are as
before. The line is fixed text of under 200 characters, so `fitParts` keeps every call within budget; the
canned models needed no change. Whether it changes what a real model writes is untested: it needs a real build
at each level.
