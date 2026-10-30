# Scaling audit (2026-10-30)

What breaks first as a course grows, checked against the rules in `CLAUDE.md` ("Engineering for
scale"). Ordered by how soon it hurts. Each item says where it is and what the fix is. Strike an item
when it's fixed.

Sizes used: a generated release snapshot is about 300 KB of JSON. An active learner writes about one
event a minute (`web/src/tracking.ts` flushes lesson time every 60 s, plus sessions, answers, checks).
A busy course: 1,000 learners × 40 hours ≈ 2.4 M events.

| # | Where | Problem | At scale | Fix |
|---|---|---|---|---|
| 1 | `SqlReleaseStore.live()` / `all()` (`src/storage/sql.ts`) | `live()` loads **and JSON-parses every release** to find the live one. It runs on most learner calls (`servedRelease`, `snapshot`, `exam`, `submitQuiz`, 27 call sites). | 100 releases × 300 KB = 30 MB parsed per call. That's CPU-bound and near the 128 MB isolate limit. | Add `status` and `parent` columns (guarded `ALTER`). Query the live row alone. Cache the parsed live release in memory, invalidated on `add`/`update`. `get(version)` stays a primary-key lookup. |
| 2 | `overview()` → `setState` (`src/app/service.ts`, 25 `pushState` calls in `worker/course-agent.ts`) | Every state push parses all releases to summarize them, then broadcasts the whole list to every connection. | 1,000 connected learners × every run step × every release. | Read summaries from columns, not from blobs. Broadcast only the live, trial and latest few releases; page the history drawer with a cursor. |
| 3 | `learners()` (Learners page) | No pagination. For each learner it runs `myProgress`, a full scan of that learner's events (N+1). | 1,000 learners × 2,400 events = 2.4 M rows parsed per page load. | A `hl_learner_summary` row per learner, updated on write (last active, quizzes, mastered, open beliefs). The page is keyset-paged (`last_active DESC, user_id`), 50 at a time, with "Load more". |
| 4 | `coachInsights()` | Scans every event of every learner on each call. | Same as #3. | A `hl_coach_targets` table (target key, learners, repaired, fixed, per approach) incremented in `submitDiagnosis` and `submitRecheck`. |
| 5 | `events.answers()` / real trials (`measureReal`, `realPerformance`) | `WHERE kind = 'answer' AND at >= ?` can't use the `(learner, kind)` index, so it scans the whole table. Then everything is loaded into memory. | 2.4 M-row scan per measurement. | Index `(kind, at)`. Aggregate per arm/lesson in SQL, or keep running per-trial counters. |
| 6 | `worker/index.ts` `courseExists` | Every connection and every RPC to a studio course first calls the **one global** `DirectoryAgent`. | A single object is capped at about 1k req/s across every course on the platform. | Ask the course object instead (it knows whether it was initialised), or cache existence in the Worker isolate, or in KV with a short TTL. Keep the directory off the per-request path. |
| 7 | `hl_events` growth | Append-only with no retention: sessions and lesson-time pings forever. | At about 300 B per event, a busy course reaches 10 GB in roughly 30 M events. Long before that, every scan above slows down. | Roll up `lesson` and `session` events into daily per-learner totals after 30 days. Keep `answer` and `check` events (trials and diagnosis need them). |
| 8 | `snapshot()`, `exam()`, `coachState()` | Send correct answers and feedback to learners' browsers before grading. | Anyone can read the answer key in devtools. That's not a load problem, but it is a correctness problem. | A learner view of items without `correct`, misconception tags or feedback. Grade on the server (already done) and return feedback after the answer. |
| 9 | `members()`, `sources()`, `myCourses()`, `profiles.all()` | Unpaginated. Sources are capped (30), but members grow with every invite. | A course shared with a class of 2,000 returns them all. | Keyset-page `members()` (`joined_at, user_id`). `myCourses` returns the first page of each group. |
| 10 | Quotas | Coach: 8 personal lessons per learner per day. Edits and builds: no quota (the owner pays, but a runaway client could loop). Activity events: limited per connection, not per user. | Cost and noise. | A per-user quota on `requestEdit` and `build`, and a per-user (not per-connection) event rate. |
| 11 | Tests | No test at volume. Every test uses a handful of learners. | Regressions like #1–#5 are invisible. | A volume test that seeds 10k events, 1k learners and 50 releases, then asserts the time and page size of `learners()`, `overview()`, `exam()` and `coachInsights()`. |

## Already fine

- Per-learner reads use the `(learner, kind)` index: `forLearner`, `answersTo`.
- Uploads are chunked under the 1 MiB WebSocket limit, with per-call (500k chars), per-file and per-course caps.
- Model calls have timeouts, retries with backoff, a per-build call budget and per-call input limits.
- Personal coach state stays out of the broadcast state.
- Builds, edits, runs and coach lessons recover after a restart (marked failed or recovered, never stuck).
