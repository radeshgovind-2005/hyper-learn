# Workstream A (Assessment v2): notes

Branch `studio/assessment`. What changed, decisions, and what other workstreams need to know.

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

## Regression check

Besides `src/eval/reference.test.ts`, I hashed `scenarioPerformance` (5 seeds per scenario),
`releasePerformance` and a seeded `simulate(..., { retakes: true })` for every scenario before the
first change, and compared after each item: identical throughout.

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
