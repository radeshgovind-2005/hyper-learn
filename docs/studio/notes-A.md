# Workstream A (Assessment v2): notes

Branch `studio/assessment`. What changed, decisions, and what other workstreams need to know.

## Summary for other workstreams

All 8 items done. Every change is backward compatible: a course without objectives or exam config
grades, simulates, routes and diagnoses exactly as before (hash-checked, see "Regression check").

| What | Change |
| --- | --- |
| `QuizAttempt` | `item_ids?: string[]` (items shown, in order; absent = whole quiz) |
| `gradeAttempt(lesson, attempt, excluded?)` | same parameters; result adds `scored: { item, position, grade }[]` |
| `attemptItems(lesson, attempt)` | new: the items an attempt showed |
| `itemStatistics(ids, rows)` | rows are `(Grade \| undefined)[]`; exclusion needs confidently negative discrimination |
| `Grade` | `objective?: string` (copied from the item) |
| `drawExam`, `examSeed`, `PILOT_ITEMS_PER_EXAM` | new, `src/assessment/exam.ts` |
| `Lesson` (Course view) | `exam?: ExamConfig`; `courseFromSnapshot` carries `exam` and `objectives` |
| `validateCourse(lessons, misconceptions?, objectives?)` | third parameter; `validateObjectives` exported |
| `liveObjectives(snapshot)` | new, `src/course/compile.ts` |
| `PathStep` | adds `{ kind: "review_section", lesson, section_id, objective, reason }` |
| `nextSteps(lessonId, grades, passed, live, objectives?)` | fifth parameter |
| `NodePerformance` | `objectives?: { id, miss_rate, responses }[]` (src/state.ts) |
| `LearnerEvent.kind` | adds `"check"` (src/storage/sql.ts) |
| `CourseService.exam(learner, lessonId)` | new → `Exam { release, lesson, attempt, items }` |
| `CourseService.submitQuiz(..., session?, item_ids?)` | sixth parameter; required for lessons with exam config |
| `CourseService.answerCheck(learner, blockId, option, session?)` | new → `{ correct, feedback }` |
| `LessonProgress` | `missed_objectives?: string[]`; `progress()` lists the served release's lessons |
| Fixture | `src/course/fixtures/studio-course.ts` (see item 8) |

Files outside A's listed area (minimal): `src/state.ts` (optional `objectives` on NodePerformance and one
conditional legend clause), `src/storage/sql.ts` (`"check"` in the kind union), `src/course/schema.ts`
(`Lesson.exam?`, Phase 0 shared file). No Worker or web files changed; C needs to add the `exam` and
`answerCheck` callables and pass `item_ids` through `submitQuiz`.

## 1. Answers keyed by item

- `QuizAttempt.item_ids?: string[]` (src/simulation/learners.ts): the items shown, in order. Absent =
  the whole quiz in quiz order, which is how every answer stored before this reads.
- New `attemptItems(lesson, attempt)` (src/analytics/performance.ts) resolves the shown items; it throws
  on a length mismatch, an unknown id or a repeated id.
- `gradeAttempt(lesson, attempt, excluded?)` keeps its parameters and its `grades` / `passed` fields, and
  adds `scored: { item, position, grade }[]` so callers can tell which item each grade belongs to
  (`position` indexes `answers` / `certainty`). Additive: existing callers are unchanged.
- `itemStatistics(itemIds, attempts)` now takes `(Grade | undefined)[]` rows (`undefined` = not shown).
  An item is judged only on attempts that showed it. Discrimination correlates an item with the *mean*
  of the other shown items instead of their sum; with every item shown that is a constant rescaling, so
  the correlation (and every featured-course result) is unchanged.
- `brokenItems` now keys grades by item id. This also fixes a latent misalignment: a short answer that
  needed review used to shift every later grade by one position.
- `attemptsFrom` (src/measure/real.ts) passes `item_ids` from the answer event's data when present.

## 2. Drawing exams

`src/assessment/exam.ts`:

- `drawExam(lesson, objectives, { seen?, seed }): QuizItem[]`. `lesson` is anything with `id`, `quiz`,
  `exam?` (a `Lesson` or a `LessonNode`). `objectives` may be the whole course's; only the lesson's own
  are used. `seen` = item ids shown to this learner before, oldest first. No `exam` config: the whole
  quiz in quiz order, unshuffled, exactly as today.
- Decision: pilot items. The plan only speaks of scored items. Pilot items exist to collect statistics,
  so each exam also shows up to `PILOT_ITEMS_PER_EXAM` (1) pilot item, chosen the same way (unseen first).
- Tie-breaks use one seeded key per pool item drawn in quiz order, so what was seen changes only the
  ranking, not the keys. The final order is a seeded Fisher–Yates shuffle.
- `examSeed(...parts)`: FNV-1a over the parts joined with NUL, then a murmur-style finaliser (same mix
  as `armOf`).

## 3. Validation

- `validateCourse(lessons, misconceptions?, objectives?)`: new optional third parameter; `buildCourse`
  passes `manifest.objectives`. The objective rules live in the exported `validateObjectives(lessons,
  objectives)`: unique ids, known lesson, an item's objective must be one of its own lesson's, every
  scored (non-pilot) item of a lesson with objectives names one, and each objective has at least
  `2 × per_objective` scored items (at least 1 when the lesson has no exam config).
- Decision: an item naming an unknown objective is refused even in a course without objectives (a
  dangling reference is a bug either way; no existing content has `objective`, so nothing changes).
- Snapshot-level rules run in `courseFromSnapshot` (they need sections and blocks): objectives parse
  with `ObjectiveSchema`, their lesson exists in the snapshot, their `sections` are sections of that
  lesson (archived sections still count, so archiving a section never invalidates a release); `exam`
  parses with `ExamConfigSchema`; check blocks parse with `CheckQuestionSchema`, have exactly one correct
  option, the correct one has `misconception: null`, misconceptions exist in the catalog, and the check's
  `objective` exists. Check rules apply whether or not the course has objectives (no existing course has
  checks).
- Objectives of an archived lesson are dropped from the `Course` view, like the lesson's quiz.

## 4. Router

- `PathStep` gains `{ kind: "review_section"; lesson; section_id; objective; reason }`. The web UI's
  existing filters ignore it until wave 2 (E renders it as "review §…").
- `nextSteps(lessonId, grades, passed, live, objectives = [])`: new optional fifth parameter. After a
  failed attempt, for each objective (course order) with a wrong answer, one step to its first section;
  a section shared by two missed objectives is suggested once; objectives without sections add nothing.
  Order: interventions, review_section, prerequisite reviews, retake.
- `Grade.objective?`: `gradeItem` copies the item's objective onto its grade, so the router (and stored
  answer events, and learner summaries) know which objective a wrong answer was about. Absent for items
  without an objective, so the featured course's grades are unchanged.
- `liveObjectives(snapshot)` (src/course/compile.ts): objectives of live lessons, with archived sections
  removed. `submitQuiz` passes it to `nextSteps`.

## 5. Analytics

- Sparse item statistics: done in item 1.
- `NodePerformance.objectives?: { id, miss_rate, responses }[]` (src/state.ts, outside A's listed files,
  as the plan suggests): only for lessons that have objectives, listing objectives with at least one
  scored, non-excluded response. `formatPerformanceData` adds one legend clause only when some node has
  `objectives`, so the featured course's Curator and Reflection prompts are byte-identical.

## 6. Simulation

- `simulate` draws each attempt's exam with `drawExam` when the lesson has an `exam` config (seed taken
  from the learner's own random stream; `seen` = that learner's earlier items for the lesson) and records
  `item_ids`. Lessons without exam config consume exactly the same random numbers as before, so every
  featured-course scenario is unchanged (checked by hash, see below).
- Found while simulating the fixture: with 2-item exams an item is correlated with one other item, so
  small negative discriminations by chance were excluding good items (and then a single slip failed an
  attempt). `negative_discrimination` now needs the correlation to be below 0 with 95% confidence
  (Fisher z). On the featured course no item was ever flagged negative (checked over all scenarios × 21
  seeds), so its data is unchanged; a miskeyed item is still caught (existing test).
- Fixture content fix from the same run: every eviction / invalidation item now has a wrong option that
  reveals the prerequisite gap, so a missing prerequisite dominates the gaps as in the featured course.
- New `STUDIO_CONTROL` scenario. The reference Curator solves `STUDIO_MISSING_PREREQ` and `STUDIO_CONTROL`
  exactly on 6 seeds each (src/simulation/exams.test.ts). Useful for B's stress test.
- Honest note for B and the demo: exams of 2–3 items make pass/fail noisy (one slip in two items is a
  50% score, under the 0.75 pass mark); masters still fail ~10% of first attempts.

## Regression check

Besides `src/eval/reference.test.ts`, I hashed `scenarioPerformance` (5 seeds per scenario),
`releasePerformance` and a seeded `simulate(..., { retakes: true })` for every scenario before the
first change, and compared after each item: identical throughout.

## 7. Service (learners)

- `exam(learner, lessonId): Exam` → `{ release, lesson, attempt, items: QuizItem[] }`: the draw for the
  learner's next attempt on their served release. Seed = `examSeed(learner, lessonId, attempt, release)`;
  `seen` = the item ids of their earlier answer events for that lesson (`item_ids`, or for answers stored
  before this, the `items[].item_id` every stored answer already has). Nothing pending is stored.
- `submitQuiz(learner, lessonId, answers, certainty, session?, item_ids?)`: recomputes the draw and
  refuses `item_ids` that differ from it (order included). `item_ids` may be omitted only for a lesson
  without an exam config (then the whole quiz, in order, as today); a lesson with one refuses a
  submission without them. Also new: `certainty` must have one entry per question (the web UI already
  sends one per item). The answer event now stores `item_ids` (always, even for the whole quiz).
  If the served release changes between `exam()` and the submit (a trial starts or a release is kept),
  the seed changes and the submit is refused; the client should reload the exam.
- `answerCheck(learner, blockId, option, session?): { correct, feedback }`: finds a live check block on
  the served release, refuses unknown blocks and non-integer / out-of-range options, and appends an event
  `{ kind: "check", lesson, release: <served>, data: { block_id, option, correct, misconception, objective?, session } }`.
- `LearnerEvent.kind` (src/storage/sql.ts, C's file; one-line change) now includes `"check"`. The only
  switch on it, `timelineOf`, shows "Practice check in <lesson>: right / wrong, showing “belief”" with
  outcome pass/fail. Checks are not counted as quizzes and are ignored by measurement (`answers()` reads
  only `answer` events).
- `progress(learner)` now iterates the *served release's* lessons (all of them, archived included, so the
  featured course lists exactly what `getCourse()` listed) instead of `getCourse()`, and adds
  `missed_objectives?: string[]` (latest attempt, only for lessons with objectives).
- Not done here (C's files): Worker callables for `exam`, `answerCheck`, and passing `item_ids` through
  `submitQuiz`; access rules (both are learner actions, like `submitQuiz`). Note that `exam()` returns
  items with their answer keys, as `snapshot()` already does; hiding keys from learners is a separate,
  larger change.
- `learnerDetail` / `myProgress` still read titles and the misconception catalog from `getCourse()`
  (left for C's course definitions).

## 8. Fixture (done early, so others can build on it)

`src/course/fixtures/studio-course.ts` exports:

- `studioSnapshot()`: a fresh `CourseSnapshot` (v1.0.0) of a made-up 3-lesson course, "Caching basics":
  `cache-hits` → `eviction` → `invalidation`. 2 objectives per lesson, 3 scored items per objective
  (`2 × per_objective + 1`, B's rule), one pilot item in `cache-hits`, `exam: { per_objective: 1 }` on
  every lesson, 6 misconceptions, prerequisite-gap tags, text blocks citing pages, one check per section.
  Item types: single_choice, multi_select, two_tier, ordering (the ones B generates).
- `STUDIO_OBJECTIVES`, `STUDIO_SOURCES` (one Markdown source, 6 pages the blocks cite), `STUDIO_COURSE_ID`.
- `STUDIO_MISSING_PREREQ`: a `Scenario` with the eviction → invalidation edge removed.

`courseFromSnapshot` now passes `objectives` and each lesson's `exam` through to the `Course` view, and
`Lesson` (src/course/schema.ts) has `exam?: ExamConfig`.
