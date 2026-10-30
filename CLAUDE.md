# HyperLearn

Adaptive course that repairs itself: agents diagnose learners' quiz answers, propose a change, and a
release harness trials it and keeps or reverts it. Meta Global AI Developer Hackathon; demo ~2026-11-05.
Architecture and setup are in README.md.

## Commands
- `npm run typecheck`: core, worker and web. Run it before saying anything is done.
- `npm test` (tsx --test). Service tests run CourseService on Node's SQLite.
- `npm run dev:worker` (:8787) and `npm run dev` (Vite on :5173, proxies /agents).
- `npm run loop -- <scenario> [--autopilot] [--agents]`: one scenario through the whole loop, no UI.

## Boundaries
- `src/` runs in both Node and the Worker. No Node-only imports (`src/runtime.test.ts` enforces this).
- `web/` imports only *types* from `src/` (`web/src/types.ts`).
- Logic belongs in `CourseService` (`src/app/service.ts`). `worker/course-agent.ts` stays thin: resolve the
  actor, check the permission, call the service, publish.
- Every `@callable` starts with `this.actor(permission)`. The matrix is in `src/app/access.ts`. The UI only
  hides controls; the server enforces.
- Guarantees live in code, not prompts: the risk tier, autopilot's R0/R1 ceiling, and keep-or-revert
  (`decideTrial`). Agents propose; code decides.
- Learner events are append-only and pinned to the release the learner was *served* (`servedRelease`).
  During a real trial, that may be the trial and not the live release.

## Engineering: how things grow (apply without being asked)
For everything you add, work out three things before you write it. Keep the fix simple, with no
infrastructure "for later", but make sure the cost stays bounded. Known gaps are in
`docs/engineering/scaling-audit.md`. Fix them when you touch that code, and don't add new ones.

1. **What does it grow with?** Every table, list, cache, broadcast or model call grows with something:
   - per course, per learner, per release, per event, per member, per file;
   - or "with time": an append-only log.

   Name it, and know whether that dimension stays small (sources: capped at 30) or doesn't (learners,
   events, releases, members).
2. **When does the work happen, and who pays?** Choose the moment deliberately:
   - **On write, once:** keep a summary row current when the thing that changes it happens. Example:
     `hl_learner_state` is refreshed when a quiz is submitted.
   - **On read, many times:** cheap only if bounded by a page or an index.
   - **In the background:** for slow work (builds, edits, coach lessons).

   Don't recompute over everything on every request, and don't write more often than anyone reads.
   Lesson time is reported every 5 minutes, not every minute.
3. **Can it be shared?** If many users get the same result, compute it once and reuse it, keyed by what
   it depends on:
   - the parsed live release, cached per instance until a write;
   - coach lessons per release, target and approach, when the learner gave no words of their own;
   - course existence, cached in the Worker for a minute.

   Personal work only where it is actually personal.

The rules that follow from that:
- **Lists that grow are paged on the server** with a keyset cursor (`WHERE (col, id) > (?, ?) ORDER BY
  col, id LIMIT n+1`), returning `{ items, next_cursor }`. Default page 50, clamped to 200. The UI shows
  "Load more". Never return or load all of a set that grows: learners, members, events, releases.
- **SQLite does the filtering, sorting and counting.** Don't load rows and use `.filter` in JS. Every
  `WHERE`/`ORDER BY` column on a growing table is indexed. No query or RPC inside a loop over a growing set.
- **Don't parse big blobs to read one field.** Queryable fields get their own columns (releases keep
  `status` and `info` beside the snapshot). Schema changes are additive and fill old rows once.
- **Durable Object limits** ([docs](https://developers.cloudflare.com/durable-objects/platform/limits/)):
  - One object is single-threaded (about 1,000 requests per second), with 128 MB of memory and 10 GB
    of SQLite.
  - A row is at most 2 MB, and an incoming WebSocket message at most 1 MiB.
  - So no single global object on the per-request path, small rows, and chunked uploads.
- **State broadcast to every connection holds summaries only**, never per-learner data or growing lists.
- **Every expensive or user-triggered operation is bounded:**
  - input sizes are checked on the server;
  - model calls have a per-user quota and a per-run budget;
  - network calls have a timeout and bounded retries;
  - polling stops.
- **Append-only logs need a retention plan.** Re-read state after every `await`. Long work is
  idempotent and recovers after a restart.
- **Each role gets only what it needs.** Learners never get answer keys or other learners' data.
- **Test at volume.** Anything that touches a growing set gets a test with realistic volume that checks
  page size and time (`src/app/scale.test.ts`).

## Security rules
- Never commit or print secrets: `.dev.vars`, `.env`, `.admin-token`.
- `AUTH_DEV_BYPASS` is for local smoke tests only. Never set it on the deployed Worker. Remove it from
  `.dev.vars` straight after testing.
- Identity comes only from Worker-set `x-hl-*` headers; `withIdentity` strips client-sent copies first.

## Smoke testing in workerd
1. Stop `wrangler dev`.
2. Back up `.wrangler/state` and `.dev.vars` to the scratchpad.
3. Add `AUTH_DEV_BYPASS=true`, then connect with `AgentClient` and `?devUser=&devRole=`.
4. Afterwards, restore both backups and restart. Check that a socket without a token gets 401.

Alternatively, leave `.dev.vars` alone: run `wrangler dev --port 8799 --persist-to <scratch dir> --var AUTH_DEV_BYPASS:true
--var KEY_ENCRYPTION_SECRET:<random>` on a spare port, and delete the scratch state afterwards.

`wrangler.jsonc` has `dev.host: "localhost"` because otherwise the custom-domain route rewrites dev URLs.

## Deploy
- A push to `main` deploys through `.github/workflows/ci-cd.yml`.
- `keep_vars: true` keeps variables set in the dashboard.
- Worker secrets: `CLERK_JWT_KEY`, `CLERK_SECRET_KEY` (optional), `MODEL_API_KEY`, `LANGSMITH_API_KEY`.

## Working agreements
- Branch off `main`. Commit, push or merge only when asked.
- A local model server (localhost:9931, 4k context) may be running evals. Never kill it mid-request.
- Say honestly what a result shows. Simulated trials test the harness, not whether teaching works.
- Writing style: match the surrounding comments. Short "why" comments, plain words, no marketing tone.
