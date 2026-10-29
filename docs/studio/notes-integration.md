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

- Never run against a real model. A 4k-context local model can't take the generator's 24 000-character
  prompts; use the Muse Spark endpoint.
- One lesson that doesn't converge in 3 rounds fails the whole build.
- `exam()` and `snapshot()` send answer keys to the browser (as on `main`).
- Short answers are still stored `needs_review` (known issue 3); generated pools have none.
- Activity rate limit per connection (known issue 5) and the Assistant's `getCourse()` tools (issue 6).
