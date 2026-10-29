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

## Regression check

Besides `src/eval/reference.test.ts`, I hashed `scenarioPerformance` (5 seeds per scenario),
`releasePerformance` and a seeded `simulate(..., { retakes: true })` for every scenario before the
first change, and compared after each item: identical throughout.
