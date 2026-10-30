# The study coach: the course that repairs itself for one learner

Course repair fixes the course for everyone, from many learners' answers. The coach does the same
for one learner, now, and feeds what it learns back to the owner.

```
"I'm stuck" (header · under each lesson · after a failed exam)
  │  lesson + "in your words, what's confusing?"
  ▼
diagnostic: 1 question per objective of the lesson (≤4) + 1 from each lesson it builds on (≤3)
  │  unseen first, questions with tagged wrong answers preferred; not graded
  ▼
code scores it → map (got it / partly / not yet) → ONE target, deepest cause first:
  gap in an earlier lesson  >  misconception (most shown)  >  weakest objective  >  "ready: take the exam"
  ▼
personal lesson (studio courses, owner's key): the build's writer + fact checker, from the pages that
teach the target, with the learner's words and wrong answers; misconception → refutation text
(featured course / no key: the course's own intervention, or the section that teaches it)
  ▼
re-check: 2 questions on the target the learner hasn't seen → fixed ✓ → next target, or the exam
                                                              → not yet → another approach
                                                                (refute → worked example → smaller steps)
  ▼
coach events → learner timeline, and coachInsights for the owner: "Fix it for everyone" = an owner edit
```

## Where things are

- `src/coach/diagnose.ts`: `drawDiagnostic`, `scoreDiagnostic` (pure, code decides the priority).
- `src/coach/repair.ts`: `writeRepair` (writer + fact check), `approachFor`, `recheckItems`, `sectionsFor`.
- Service: `coachState`, `startDiagnosis`, `submitDiagnosis`, `beginRepair` / `continueRepair`,
  `submitRecheck`, `coachInsights`. State per learner in meta `coach:<learner>`; never in the shared
  overview (the page polls while a lesson is written). Callables: all `learn`, insights `view_learners`.
- UI: `web/src/pages/Coach.tsx` (`/coach`, `/c/<id>/coach`), `web/src/components/CoachInsights.tsx` (studio).

## Decisions

- **Code picks the target, a model only writes.** The ranking mirrors a knowledge-space "ready to learn"
  fringe: fix what later lessons depend on before polishing the top.
- **Refutation texts for misconceptions** (meta-analysis: g = 0.41), with a different approach on a retry
  instead of the same explanation again (a refutation can entrench a belief for some learners).
- **Grounded like the course**: the personal lesson cites the course's own pages and is fact-checked;
  doubts are shown to the learner.
- **Diagnostic and re-check questions count as seen**, so the exam prefers others; they aren't graded and
  don't count as exam attempts.
- **Cost**: 2–4 model calls per personal lesson on the owner's key, capped at 8 per learner per day.

## Measured (local workerd, Muse Spark)

A learner who wrote "I thought more processors always means proportionally faster" was diagnosed in 4
questions; the gap was traced to the earlier speedup lesson; the personal lesson (63 s, worked example,
every block citing the notes, no fact-check doubts) opened with their own belief; 2 new questions passed,
and the misconception came next. One learner, scripted: it shows the loop works, not that it teaches.

## Not done

- Adaptive question selection inside the diagnostic (it is a fixed short draw).
- Promoting a personal lesson that worked into the course directly (today: "Fix it for everyone" asks
  the editor, which writes its own version).
