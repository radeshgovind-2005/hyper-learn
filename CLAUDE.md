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

## Engineering for scale (apply without being asked)
Design every feature as if a course has 10,000 learners, a million events and 100 releases. Fast with
10 rows proves nothing. Current gaps are in `docs/engineering/scaling-audit.md`: fix them when you touch
that code, and don't add new ones.
- **Lists grow, so paginate on the server.** Anything that grows with users, events, releases or time is
  paged with a keyset cursor (`WHERE (col, id) < (?, ?) ORDER BY col DESC, id DESC LIMIT n+1`), returning
  `{ items, next_cursor }`. Default page size 50, clamped to 200. Never return or load "all" of a growing set.
- **SQLite does the work.** Filter, sort, count and aggregate in SQL, never by loading rows and using
  `.filter`/`.map` in JS. Every column in a `WHERE`/`ORDER BY` on a growing table has an index; check new
  queries with `EXPLAIN QUERY PLAN`. No N+1: no query or RPC inside a loop over learners, courses or events.
- **Precompute what is read often.** Dashboards and insights read summary rows updated on write (or a
  cache with explicit invalidation), not a recomputation over the whole event log per request.
- **Don't parse big blobs to read one field.** Fields you query (status, version) live in their own
  columns. Keep a parsed hot object (the live snapshot) in memory per instance, invalidated on write.
- **Durable Object limits** ([docs](https://developers.cloudflare.com/durable-objects/platform/limits/)):
  - One object is single-threaded with a soft limit of about 1,000 requests per second.
  - The isolate has 128 MB of memory. Each object's SQLite holds at most 10 GB.
  - A row is at most 2 MB, and a query takes at most 100 bound parameters.
  - An incoming WebSocket message is at most 1 MiB.
  - So no global object on the per-request path (cache lookups), small rows, chunked uploads, and
    bounded work per call.
- **Broadcast state stays small and bounded.** `setState` goes to every connection on every change: put
  only summaries there, never per-learner data or unbounded lists. Send details when asked.
- **Every input and every expensive operation is bounded.** Sizes are checked on the server. Model calls
  carry a per-user quota and a per-run budget. Every network call has a timeout and bounded retries with
  backoff. Polling stops or backs off.
- **Logs that only grow need a retention or compaction plan** before they ship.
- **Concurrency: re-read state after every `await`.** Another call may have run in between (input gates
  only hold between awaits). Long work runs in the background, is idempotent, and recovers after a restart.
- **Schema changes are additive and work on live objects** (`CREATE … IF NOT EXISTS`, guarded `ALTER`).
  Old rows must still read.
- **Send each role only what it needs.** Learners never get answer keys or other learners' data.
- **Test at volume.** Anything that loops over learners, events or releases gets a test with realistic
  volume (for example 10k events) that bounds its time or query count.
- **The UI doesn't fetch whole datasets.** It pages ("Load more"), and it debounces input.

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
