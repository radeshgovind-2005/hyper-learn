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
