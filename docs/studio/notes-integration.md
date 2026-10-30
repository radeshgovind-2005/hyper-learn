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
