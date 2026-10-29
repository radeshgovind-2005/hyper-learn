# Workstream C (Platform): notes

Branch `studio/platform`. Written after the fact from the code and commit messages: the agent that did C
was stopped before writing them. Items 1–8 of PLAN §C are in; 282 tests, typecheck passes.

## Summary for other workstreams

| What | Where |
| --- | --- |
| `ModelProvider` (config in, `chat(type)`, `structured` out); `defaultModels()` for Node; `refuseDefaultModels()` | `src/models.ts` |
| `modelConfigFromEnv(env)`, `modelChoicesFromEnv(env)` | `src/models.ts` |
| Node creators (`createCuratorModel`, `createApproverModel`, …) take an optional provider; `graphModels(provider)` | `src/nodes/*`, `src/graph.ts` |
| `CourseDefinition { id, base, scenarios, defaultScenario?, exemplars }`, `builtInCourse(id)`, `FEATURED_COURSE` | `src/app/courses.ts` |
| `CourseBuilder = (input, structured, onStep) => Promise<BuildResult>` | `src/app/courses.ts` |
| Studio ids `c-` + 12 random `[a-z0-9]`; `isStudioId`, `newCourseId`, `routeAllowed` | `src/app/courses.ts` |
| `DirectoryService` (courses, memberships) | `src/app/directory.ts` |
| `coursePermissions`, `requireCoursePermission`, `mayEnter`, `COURSE_ROLES`, permission `manage_course` | `src/app/access.ts` |
| `sealSecret` / `openSecret` (AES-GCM, HKDF from the Worker secret, bound to the course id) | `src/crypto/keys.ts` |
| `SqlMembers`, `SqlSources` (tables `hl_members`, `hl_sources`) | `src/storage/studio.ts` |
| `CourseService` options: `course` (definition or `"studio"`), `models`, `builder`, `ownerModels`, `directory` | `src/app/service.ts` |
| `NoExemplar`: a reference run that needs an exemplar the course lacks ends with "Needs a model to write this" | `src/interventions/reference.ts` |
| Empty builder slot | `worker/builder.ts` |

`CourseService` no longer calls `getCourse()`: `course()` compiles the definition's v1.0.0 once (built in, or a
studio course's published release). `progress`, `myProgress`, `learnerDetail` use it. Remaining `getCourse()`
uses are Node tools and the Assistant's tools (`src/tools/index.ts`, wave 2 D).

## Durable Objects and routing

- `CourseAgent`, one per course, named by course id. `agentic-coding` is the featured course (same name as on
  `main`, so production data stays). Studio courses get `c-…` names from the directory.
- `DirectoryAgent`, one object named `main`.
- `worker/index.ts` `admit()`: signed in (401), then `routeAllowed` (404) **before** routing, because routing to
  a name creates the object. `route.className` is the env binding name (`AgentRouteMatch.className: keyof Env`),
  checked against the Agents SDK types.
- `CourseAgent.onConnect`: unknown name 4004, no identity 4001, not a member 4003. `validateStateChange` refuses
  browser writes. `refuseDefaultModels` in the Worker: a course can only use its own provider.
- `wrangler.jsonc`: `DirectoryAgent` binding and migration `{ tag: "v2", new_sqlite_classes: ["DirectoryAgent"] }`.

## Callables

`DirectoryAgent` (anyone signed in): `myCourses()` (owned, shared, featured), `createCourse({ title, description })`
→ `{ id }` (records it, then `initialise` over RPC; forgets it if that fails), `join(courseId, token)` → `{ id, role }`.
RPC only: `courseExists(id)`, `courseUpdated(id, patch)`, `membershipChanged(id, userId, role)`.

`CourseAgent`, new (permission in brackets):

| Callable | |
| --- | --- |
| `me()` [learn] | adds `courseRole` and `permissions` from `coursePermissions` |
| `members`, `setMemberRole(userId, role)`, `removeMember(userId)` [manage_course] | owner can't be changed or removed; removal closes their sockets |
| `leave()` [learn] | the owner can't leave |
| `invite`, `rotateInvite`, `revokeInvite` [manage_course] | 24 random bytes, base64url; compared in constant time |
| `updateDetails({ title?, description?, goal?, language? })` [manage_course] | |
| `sources`, `addSource({ name, pages, role? })`, `appendPages(id, pages)`, `removeSource(id)`, `setSourceRole(id, role \| null)` [manage_course] | only in draft/review |
| `modelSettings()`, `setModelKey(key, model)`, `clearModelKey()` [manage_course] | key never returned |
| `build()`, `draft()`, `publish()` [manage_course] | |

RPC only: `initialise({ id, title, description, owner })`, `redeemInvite(person, token)`.

Existing callables are unchanged apart from going through `requireCoursePermission`. Not yet added (A's):
`exam`, `answerCheck`, `item_ids` on `submitQuiz` — integration.

## Roles

| | learner | editor | owner | global admin |
| --- | --- | --- | --- | --- |
| learn | ✓ | ✓ | ✓ | ✓ |
| repair, view_learners | | ✓ | ✓ | ✓ |
| reset, manage_course | | | ✓ | ✓ |
| manage_roles (Clerk) | | | | ✓ |

The featured course keeps global roles (`permissionsOf`). Course roles are read on every call, so a change applies at once.

## Sources, key, lifecycle

- Limits (`SOURCE_LIMITS`): 30 sources, 2 000 000 chars total, 500 000 per call (`appendPages` for the rest),
  2 000 pages per source, pages cut at `MAX_PAGE_CHARS`. Source ids `s1, s2, …` never reused.
- Key: 8–400 chars, no spaces. Needs `KEY_ENCRYPTION_SECRET` ≥ 32 chars, else a clear refusal. Model must be in
  `MODEL_CHOICES` (comma list; empty = `REASONING_MODEL`). Base URL is always `MODEL_BASE_URL`. Opened keys are
  redacted from every error and build step that reaches state.
- `draft → building → review → published`. `build()` checks synchronously (sources, builder, key), runs the
  builder in `keepAliveWhile`, records steps in `overview.build`. Code sets `course_id` and `version: "1.0.0"`
  and runs `courseFromSnapshot` on the result. A failed rebuild keeps an earlier draft in review. A course
  still `building` when the service starts was cut off by a restart and is marked failed.
- `publish()` adds release 1.0.0. Learner calls on an unpublished course throw `NotPublished`; `startSession`
  records nothing for a draft. A published course can't be rebuilt and its sources are frozen (lessons cite them).
- Studio courses have no scenarios: only runs on real learners.

## Env and secrets

- New secret `KEY_ENCRYPTION_SECRET` (`npx wrangler secret put KEY_ENCRYPTION_SECRET`, e.g. `openssl rand -base64 32`).
  Changing it makes stored keys unreadable. Without it, owners can't save keys; nothing else breaks.
- New var `MODEL_CHOICES` (default in `wrangler.jsonc`: `muse-spark-1.3`).

## Open points

- Callable arguments of the existing repair callables are still not validated (`approve`, `startRun` mode and agents).
- `exam()` and `snapshot()` return answer keys to learners (as `main` does).
- The repair-run restart recovery is a separate fix off `main` (`fix/stuck-run`); builds already recover here.
