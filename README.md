# hyper-learn

**HyperLearn** is an adaptive learning platform built on a self-correcting hypergraph (lessons → sections →
blocks, with prerequisites and named misconceptions). Agents diagnose the course from learners' answers and
propose repairs; a harness in code validates, versions, measures and keeps or reverts them. Built with
LangGraph.js, LangChain.js and Zod, running in a Cloudflare Worker (Agents SDK + Durable Objects) with a React UI.

## Architecture

```
            ┌──────────── supervisor ────────────┐
            ▼                                    ▼
   assistant ⇄ tools                    curator → reflection
            │                              ▲          │
            ▼                              └─ reject ─┤
           END                                        ▼ approved (with a release harness)
                       add_intervention → author ⇄ review_content ─┐   other actions ─┐
                                                                   ▼                  ▼
                  plan_release → approve (human or autopilot) → measure → decide → END
```

- **Supervisor** routes on `input_type`: `cron` goes to the Curator, `user_question` goes to the Assistant.
- **Curator** (high autonomy) reads performance data and proposes exactly one Zod-validated mutation.
- **Reflection** reviews each proposal. A rejected proposal goes back to the Curator, which gets the critique. The loop allows at most 2 attempts.
- **Reflection runs code checks first**: ids exist, the target is set correctly, no cycles or duplicate edges, and the reason cites the lesson's real fail rate. An invalid proposal is rejected instantly, without a model call.
- **Release harness** (optional, `buildGraph(models, { harness })`): an approved proposal becomes a candidate
  release, waits for approval, runs as a trial, and is kept or reverted on its measured outcome. See below.
- **Learner Assistant** (low autonomy) calls `query_hypergraph`, `read_lesson`, `generate_diagram` and `navigate_ui` through a `ToolNode` loop.

| Path | Purpose |
| --- | --- |
| `content/agentic-coding/` | The course: `course.json` plus one Markdown lesson per file, each ending in a quiz |
| `content/agentic-coding.bundle.json` | The course compiled into release v1.0.0 (`npm run bundle`) |
| `src/assessment/` | Question types, their graders, and correct/wrong responses for the simulation |
| `src/course/` | Course schemas, loader, validation, graph helpers and the content-graph compiler |
| `src/simulation/` | Seeded learner simulation and the evaluation scenarios |
| `src/analytics/` | Turns quiz attempts into per-lesson performance data: gaps, named misconceptions, BKT mastery, item quality |
| `src/eval/` | Rule-based reference Curator, scoring and the `npm run eval` runner |
| `src/mutations.ts` | Code checks a mutation must pass before Reflection |
| `src/interventions/` | Intervention templates (contrast, practice, step-through), their code checks, hand-written exemplars |
| `src/path/route.ts` | Per-learner router: what a learner sees after a quiz |
| `src/retrieval/context.ts` | Graph retrieval: the Author's budgeted context |
| `src/guards/` | Optional Guard (safety) and Embedder (paraphrase) interfaces |
| `src/nodes/author.ts`, `src/nodes/approver.ts` | Author and content review; the autopilot Approver agent |
| `src/releases/` | Typed changes (apply, invert, risk tier, semver), releases, trials, promote and revert |
| `src/measure/` | Measuring a trial on simulated or real learners (`real.ts`: arms, pending until enough), and the keep-or-revert rule |
| `src/auth/` | Clerk token verification, identity headers, role changes |
| `src/app/` | `CourseService` (everything a course object does), the directory, course definitions, the access matrix, the run timeline |
| `src/crypto/` | Sealing owners' model keys (AES-GCM, WebCrypto) |
| `src/nodes/release.ts` | Harness nodes: plan_release, approve (interrupt or autopilot), measure, decide |
| `src/cli/loop.ts` | `npm run loop`: one scenario through the whole loop |
| `src/index.ts` | Demo runner |
| `src/graph.ts` | Graph wiring and conditional edges |
| `src/state.ts` | State annotation and Zod schemas |
| `src/models.ts` | `ModelProvider` (one per course) and the default provider for Node entry points |
| `src/nodes/*` | Supervisor, Assistant, Curator, Reflection |
| `src/tools/index.ts` | Assistant tools over the course, and the tool registry |
| `src/config/agents.json` | Agent definitions: role, goal, instructions, model, tools… |
| `src/agents.ts` | Validates `agents.json` and assembles each system prompt |

## The app

Three panes: the learning path and release history on the left, the lesson and its quiz in the middle, and
course repair on the right (pick simulated or real learner data, run the loop, approve, watch the trial decide).

```bash
npm run build:web && npm run dev:worker   # http://localhost:8787 — the Worker serves the built UI
# or, with hot reload for the UI:
npm run dev:worker                        # terminal 1: the Worker on :8787
npm run dev                               # terminal 2: Vite on :5173, proxying /agents to :8787
```

- `worker/` — the Worker. `CourseAgent` (an Agents SDK Durable Object) wraps `CourseService` (`src/app/service.ts`),
  which owns everything the app remembers in the object's SQLite: releases, the learner event log (each answer
  pinned to the release the learner saw), and LangGraph checkpoints (`src/storage/checkpointer.ts`), so a run
  paused for approval survives the object being evicted. Browsers stay in sync through the agent's state.
- `web/` — the React UI (Vite). It imports only types from the core.
- The core in `src/` runs in both Node and the Worker; `src/runtime.test.ts` keeps Node-only imports out of it.
- Workers AI provides Llama Guard (safety) and bge embeddings (paraphrase checks). Both fail open: locally,
  without `wrangler login`, they're skipped and the code checks still run.
- Without a model key, runs use the reference stand-ins (rule-based Curator, hand-written exemplars) and make no
  model calls; the UI says so. With `MODEL_BASE_URL` and `MODEL_API_KEY` set (`.dev.vars` locally,
  `npx wrangler secret put MODEL_API_KEY` deployed), the "Muse Spark" toggle runs the real agents. Point
  `MODEL_BASE_URL` at a Cloudflare AI Gateway to log every model call.
- **Accounts (Clerk).** Everything needs sign-in, through a split-screen page (`/sign-in`, `/sign-up`). The
  browser sends its Clerk session token with the agent connection; the Worker verifies it (networkless, with
  `CLERK_JWT_KEY`) before anything reaches the Durable Object, which then knows who is on each connection.
  Roles come from the token's `role` claim (Clerk user public metadata), defaulting to learner:

  | | learner | instructor | admin |
  | --- | --- | --- | --- |
  | lessons, quizzes, own progress | ✓ | ✓ | ✓ |
  | course repair (run, approve), see learners | | ✓ | ✓ |
  | reset the course, manage roles | | | ✓ |

  Admins change roles on a learner's page (`/learners/:id`). The role is written to the person's Clerk public
  metadata (needs the Worker secret `CLERK_SECRET_KEY`) and applies when their browser next connects. Admins
  can't change their own role, so the last admin can't lock everyone out.

- **Studio courses: one Durable Object per course.** Besides the featured course (`agentic-coding`, the object
  of that name, global roles as above), anyone signed in can create a course. `DirectoryAgent` (one object,
  `main`) lists courses and memberships; each course is a `CourseAgent` named by its id (`c-` and 12 random
  characters). The Worker refuses any other name with 404 before routing, so a guessed id creates nothing.
  In a studio course, access comes from the person's role in that course (stored in its object); global admins
  may do everything anywhere:

  | | learner | editor | owner |
  | --- | --- | --- | --- |
  | lessons, quizzes, own progress | ✓ | ✓ | ✓ |
  | course repair (run, approve), see learners | | ✓ | ✓ |
  | sources, model key, build, publish, invite link, members, reset | | | ✓ |

  Non-members can't connect (4003). People join through the owner's invite link (the directory's `join`),
  as learners; the owner can make them editors. A course goes draft → building → review → published:
  the owner uploads sources (page texts; at most 30 files and 2,000,000 characters), sets a model API key,
  builds (the generator runs in the background with that key), reviews the draft and publishes it as
  release 1.0.0. Learners can't open a course before it's published. The owner's key is stored only
  encrypted (AES-GCM, key derived from the Worker secret `KEY_ENCRYPTION_SECRET`, bound to the course) and is
  never shown again; calls always go to the Worker's `MODEL_BASE_URL`, and owners pick a model from
  `MODEL_CHOICES`. Set the secret once with `npx wrangler secret put KEY_ENCRYPTION_SECRET` (at least 32
  characters, e.g. `openssl rand -base64 32`; changing it makes stored keys unreadable, so owners re-enter them).

- **What's recorded per account** (the append-only event log, each event pinned to the release the person saw):
  connections opening and closing (merged into sessions when less than 30 minutes apart), visible time on each
  lesson, interventions shown and completed, and every quiz answer with its certainty. The browser can only report
  its own learner's lesson time and interventions, validated against the live release and rate-limited; everything
  else is recorded by the server. `/me` ("My progress") shows mastery, time, sessions, quizzes and the beliefs a
  learner has shown and cleared, and "Delete my data" removes their history.

- **Instructors** (`/learners`): every learner with when they were last active, sessions, time, lessons
  mastered and the beliefs they still show, a "needs help" filter, the misconceptions most learners hold, and
  for each learner their progress and a readable timeline. Names come from the session token when it carries
  `name` and `email` claims; otherwise learners are listed by their user id.

  Setup: in Clerk, add the session-token claims
  `{ "role": "{{user.public_metadata.role}}", "name": "{{user.full_name}}", "email": "{{user.primary_email_address}}" }`
  (only `role` is required) and set your own
  public metadata to `{ "role": "admin" }`; set `VITE_CLERK_PUBLISHABLE_KEY` (`.env` locally, a GitHub Actions
  variable for CI) and the Worker secret `CLERK_JWT_KEY` (`.dev.vars` locally). For in-app role changes, also
  `npx wrangler secret put CLERK_SECRET_KEY` (Clerk dashboard → API keys → secret key).

- **Real learners as the data source.** Course repair can diagnose and trial on the people using the app instead
  of a simulated scenario. Diagnosis uses everyone's first quiz attempt on the live release; with few learners,
  every lesson is `low_sample` and the agents don't act on noise. An approved change becomes a trial: each
  learner is put in one half by a stable hash of their id and the trial version, and served that half's release
  (content, routing and grading). The run then waits as "trial running": the trial is measured every hour, or
  when an instructor presses Evaluate now, and decided by the same keep-or-revert rule once both halves have 30
  learners on the measured outcome. An instructor can also stop it, which reverts it. Only one real trial runs
  at a time.
- Live at **https://hyperlearn.radesh-govind.com**. `.github/workflows/ci-cd.yml` typechecks, tests and builds every
  push and pull request, and deploys every push to `main` that passes. It needs one repository secret,
  `CLOUDFLARE_API_TOKEN` (a token from Cloudflare's "Edit Cloudflare Workers" template). Worker secrets
  (`CLERK_JWT_KEY`, `CLERK_SECRET_KEY`, `MODEL_API_KEY`, `KEY_ENCRYPTION_SECRET`, `LANGSMITH_API_KEY`) are set once with `wrangler secret put` and survive deploys.
- Manual deploy: `npx wrangler login`, then `npm run deploy`.

## Setup

```bash
npm install
cp .env.example .env   # points at the local llama.cpp server on :9931 by default
npm run typecheck      # the Node code, the Worker (against Workers types) and the UI
npm test               # all deterministic tests: no model server needed, a few seconds
npm start              # demos against the real model
npm run eval           # score the agents on the simulated scenarios
npm run loop -- missing-prereq   # diagnose → propose → release → approve → trial → keep or revert
```

## The course

`content/agentic-coding/` holds a 6-lesson course on agentic coding:

```
llm-basics → agent-loop → tool-calling ─┐
llm-basics → structured-output ─────────┴→ multi-agent → reflection
```

`course.json` lists each lesson's id, title, summary, file and prerequisites, plus a catalog of named
**misconceptions**: beliefs a wrong answer can reveal, each tied to the lesson that teaches the correct idea
(e.g. `model-executes-actions`: "The model carries out the actions it chooses"). Each lesson is a Markdown
file ending in a fenced `quiz` block.

Quiz items come in nine types. All are scored in code (`src/assessment/grade.ts`) into the same result: a score,
whether it was correct, and the wrong answers it revealed. Analytics never needs to know an item's type.

| Type | The learner… | A wrong answer is tagged on… |
| --- | --- | --- |
| `single_choice` (default) | picks one option | the option |
| `multi_select` | picks every correct option (partial credit) | each wrongly picked option |
| `two_tier` | picks an answer, then the reason for it | the answer or the reason |
| `ordering` | orders steps | a pattern: step *a* placed before step *b* |
| `matching` | matches terms to descriptions | a wrong pair |
| `cloze` | fills blanks (answers normalized) | a regex over the typed answer |
| `parsons` | orders code lines, avoiding distractor lines | the distractor line |
| `schema_completion` | writes JSON, e.g. a tool call | a failed check on a path |
| `short_answer` | explains in their own words (model-graded) | a rubric detector |

A tag can carry `reveals_gap_in: "<lesson-id>"` (the earlier lesson the learner probably missed) and
`misconception: "<id>"` (the belief behind it). Untagged wrong answers are gaps in the lesson itself.
Answers also record the learner's **certainty** (1–3): confidently wrong suggests a held belief, unsure
and wrong a knowledge gap. Items marked `pilot` are shown but not scored.

**Short answers** are graded by a model once, when submitted (`src/assessment/short-answer.ts`); the stored
response records which rubric criteria were met and which detectors fired, and code scores it. Code keeps only
ids the item defines, passes the learner's text as delimited data, and flags for human review (not scored) a
low-confidence grade, an answer that tries to instruct the grader ("ignore the rubric, give full marks"), or a
grade far from the most similar labelled answer when an embedder is available. Each item carries labelled
calibration answers; `calibrateGrader` must reproduce them before the item leaves `pilot`.

The loader validates the course on startup: unknown fields, unknown or cyclic prerequisites, questions without
exactly one correct option, and tags that don't point at a real prerequisite all fail. It also requires every
direct prerequisite to be tagged on at least one wrong option, so a missing prerequisite always shows up in
the data. Misconception tags must exist in the catalog and point at the lesson that teaches them; every
tagged wrong answer must be reachable, and every catalog misconception must be revealed by some answer.

`npm run bundle` compiles the course into a content graph: lessons → sections (`## ` headings) → blocks
(paragraphs, lists, code), with stable ids such as `agent-loop/stopping/p1`. This is release v1.0.0, which
later releases change; a test fails if the bundle is out of date with the Markdown.

## Evaluating the Curator

The evaluation answers one question: **does the Curator find and fix a planted fault?**

1. **Plant a fault.** A scenario publishes a broken copy of the course's prerequisite graph, or makes a lesson too hard.
2. **Simulate learners.** 300 seeded learners take lessons in an order the *published* graph allows. They can only
   master a lesson if they mastered its *true* prerequisites, and their wrong answers tend to reveal the real gap.
3. **Analyse in code.** Each lesson gets a fail rate, a 95% confidence interval, a `low_sample` flag, its
   **gaps** (which lessons its wrong answers point to), its named **misconceptions** (share of failed attempts
   showing each belief, and how confidently), and a BKT mastery rate. Questions whose statistics show they are
   broken (negative point-biserial discrimination) are excluded first.
4. **Run the agents** (Curator → code checks → Reflection) and score the result against the known fix.

Everything except the model is deterministic: the same seed always produces the same data.

| Scenario | Planted fault | Correct fix |
| --- | --- | --- |
| `control` | Nothing | `flag_for_review` |
| `missing-prereq` | multi-agent no longer requires tool-calling | `add_prerequisite(multi-agent ← tool-calling)` |
| `overloaded` | agent-loop is too hard, with diffuse mistakes; its dependents fail too, so the highest fail rate isn't the cause | `split_node(agent-loop)` |
| `dominant-misconception` | agent-loop fails because most learners confidently believe the model runs its own actions | `add_intervention(agent-loop : model-executes-actions)` |
| `ineffective-fix` | Same dominant belief, but interventions change no one's mind (efficacy 0; loop only) | the intervention trial must be reverted |
| `harmful-edge` | Nothing; a proposal to drop tool-calling's real prerequisite is injected (loop only, skipped by eval) | the harness must revert it |
| `low-sample-trap` | missing-prereq, plus a 10-attempt lesson with a 90% fail rate | `add_prerequisite(multi-agent ← tool-calling)` |

A **rule-based reference Curator** (`src/eval/reference.ts`) must solve every scenario; the tests check it on 21
seeds each. If it couldn't, the data wouldn't contain the fault and the scenario, not the agent, would be broken.

```bash
npm run eval -- --reference-only        # instant: data tables and the reference's answers
npm run eval -- missing-prereq          # one scenario, with the agents
npm run eval                            # everything (slow on a local model)
```

Scores: `exact` (the planted fault's fix, including the targeted misconception), `right_lesson` (right lesson, wrong action or target), `miss`.
The report shows both what would be applied (only if Reflection approved) and the Curator's last proposal,
which separates Curator mistakes from Reflection mistakes. If a step fails (say, Reflection runs out of context), the
Curator's proposal is still recorded and scored. Each run writes `reports/eval-<timestamp>.json`
after every scenario, so a long run that is cut off keeps its finished results.

The Curator's instructions describe the same root-cause procedure the reference follows, so the evaluation
measures whether the model applies that reasoning to the numbers correctly, not whether it invents it.

## Releases and the repair loop

Agents propose; the harness decides. Every guarantee below is code, not an instruction to a model.

1. **Plan.** The approved proposal becomes typed changes (`add_prerequisite`, `remove_prerequisite`,
   `archive_node`, `restore_node`, `add_block`) applied to a *copy* of the live release. The whole course is re-validated
   with every loader rule; a candidate that breaks one is refused. Code assigns the **risk tier** (R0 additive
   content, R1 changes what or in which order learners study, R2 whole lessons or the quiz) and the **semver
   bump** (a prerequisite change is major).
2. **Approve.** In `hitl` mode the graph pauses with LangGraph's `interrupt()` on every change and resumes with
   `new Command({ resume: { approved } })`. In `autopilot` mode an approver decides, but only up to R1: an R2
   change always goes to a human.
3. **Trial.** The candidate runs as `2.0.0-trial.1` next to the live release. Nothing live is modified.
4. **Measure.** The same simulated cohort, on a fresh seed (not the one that produced the diagnosis), is routed
   through both releases. The primary metric is the changed lesson's fail rate; every other lesson is a
   guardrail. Learners who fail retake the quiz after the per-learner router's remediation. For an intervention
   the primary metric is **persistence**: of the learners who failed showing the targeted belief, how many still
   show it on the retake. Differences come with a 95% confidence interval (Newcombe's method).
5. **Decide.** Keep only if the change did what it claimed (an `improve` change lowers the primary rate by at
   least 10 points with confidence; a `no_harm` change, like removing a prerequisite, can't raise it by 5) and
   no guardrail got worse. Anything else, including an inconclusive result, reverts: the trial is marked
   `reverted` and the live release stays. A kept trial is released as `2.0.0`. Every change has an exact
   inverse, so history is complete and any release can be undone.

```bash
npm run loop -- missing-prereq              # rule-based Curator, no model calls; asks you to approve
npm run loop -- harmful-edge --yes          # a bad change approved by a human is still reverted
npm run loop -- missing-prereq --autopilot  # autopilot approves within its ceiling
npm run loop -- dominant-misconception      # an intervention is authored, released as 1.1.0, kept
npm run loop -- ineffective-fix --autopilot # the same intervention, which doesn't work, is reverted
npm run loop -- missing-prereq --agents     # the real agents (Curator, Reflection, Author, Reviewer, Approver)
```

**What this proves, and what it doesn't.** Simulated learners follow rules we wrote, so a trial shows that the
harness targets the right lesson, applies changes safely, and keeps or reverts correctly under noise. It does
not show that a change helps real learners; a trial on real learners (in the app) applies the same rule to them.

Splits and merges are reviewed and recorded, but not released: no agent writes whole lessons yet.

## Interventions and per-learner paths

Each run diagnoses the **live** release: the scenario's learners are routed through its prerequisite graph,
and every named misconception that a live intervention already targets is marked `covered`. Code rejects a
proposal for a covered belief, so once a fix is kept the next run moves on instead of re-proposing it.

An `add_intervention` proposal targets one named misconception. Code decides which **templates** fit from how
the belief is held: confidently held → `contrast` (belief, why it's tempting, what really happens, a check
question) or `step_through` (a frame-by-frame player of the message list, e.g. one turn of the agent loop);
unsure → `practice` (2–3 questions with feedback on every option). Templates are Zod-validated JSON that the UI
renders, never generated code.

The **Author** gets context assembled by walking the course graph (`src/retrieval/context.ts`), within a fixed
budget: the belief and its evidence, the quiz questions that reveal it (marked "do not reuse"), the lesson's
sections by id, earlier trials for the same belief and how they ended, and a format example. Its draft passes
**code checks** first: the template is one code allows, the section is real, the target is the diagnosed belief
taught in this lesson, a wrong option expresses the belief, no markup or links, nothing repeats or gives away a
quiz question (word overlap, and paraphrase via an optional embedder), no duplicate of a live intervention, and
an optional safety model (Llama Guard). Only then does the **Content Reviewer** judge accuracy and clarity. A
rejected draft goes back with the problems, at most twice. An intervention is R0 and a minor bump.

Interventions aren't added to the text everyone reads. The **per-learner router** (`src/path/route.ts`) shows
one to a learner who fails a quiz showing its belief, reviews a prerequisite their answers revealed a gap in,
then offers a retake. The simulation delivers interventions through the same router; whether one clears a
belief is the scenario's declared `efficacy`, which is why a kept intervention proves the machinery, not the
pedagogy.

Without `--agents`, `npm run loop` releases hand-written exemplars (`content/agentic-coding/exemplars.json`) in
place of the Author; they pass the same checks. In autopilot, `--agents` also uses the **Approver** agent,
still only within the R0–R1 ceiling.

### Configuring agents

Each agent in `src/config/agents.json` is a structured object, not a prompt string. `src/agents.ts` validates
the file with Zod at startup (unknown fields and unknown tool names fail fast) and assembles the system prompt
from these fields, in this order:

| Field | Required | Purpose |
| --- | --- | --- |
| `name` | yes | Human-readable name |
| `model` | yes | Model profile: `reasoning` or `fast` |
| `role` | yes | Who the agent is; opens the prompt |
| `goal` | yes | What it is trying to achieve |
| `context` | no | Background, added after the file-level `shared.context` |
| `instructions` | no | How to do the job |
| `checks` | no | Numbered `{ name, rule }` checklist |
| `constraints` | no | Hard rules |
| `output_format` | no | How to shape the answer; closes the prompt |
| `tools` | no | Tool names from `TOOL_REGISTRY` in `src/tools/index.ts` |
| `templates` | no | Extra prompts with `{placeholder}` slots, used via `renderTemplate()` |

### Tests

`npm test` covers the question types and graders, course loader and compiler, simulation, analytics (BKT,
item statistics, misconceptions), code checks, reference Curator, releases (apply/invert round trips, tiers,
versions, promote/revert), the keep-or-revert rule and the simulated measurer. `src/harness.test.ts` runs the
release harness in the graph with fakes: a human approval pause and resume, a rejection, a revert, autopilot
within its ceiling, and an R2 change escalated to a human. `src/agents.test.ts` covers config validation and prompt assembly. `src/graph.test.ts` builds the graph with scripted fake models (`buildGraph({ curator, reflection, assistant })`)
and checks the routing, not the model's judgement:

- an approved proposal ends after one round
- a rejection loops back to the Curator, whose retry prompt carries the critique and the rejected proposal
- an invalid proposal is rejected by code checks without calling the reviewer model
- the loop gives up after `MAX_CURATOR_ATTEMPTS` rejections
- the Assistant runs a requested tool and loops back to answer

This is the reliable way to exercise the reject → retry path. Whether a real model rejects anything depends on its judgement.

### Demos

`npm start` runs every demo in order. Pass one or more ids to run only those:

```bash
npm start -- assistant                    # a learner question, answered with the course tools
npm start -- missing-prereq overloaded    # Curator demos, in the order defined in src/index.ts
```

The ids are `assistant` plus one Curator demo per evaluation scenario (`control`, `missing-prereq`, `overloaded`,
`low-sample-trap`). The Curator demos print the agents' result without scoring it; `npm run eval` scores them.
An unknown id fails with the list of valid ones.

### Tracing with LangSmith

Every run can be traced in LangSmith: each graph node (Curator, Reflection, Author, review, release planning,
approval, measurement, decision) and every model call, under one root run per invocation. Set
`LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` and optionally `LANGSMITH_PROJECT` in `.env` (Node) or as Worker
vars and secrets. Root runs are named `repair-run` (the app), `loop`, `eval` or `demo`, tagged `hyperlearn`,
`scenario:<id>`, `mode:<hitl|autopilot>` and `agents:<model|reference>`, with the run's `thread_id` and the live
release in their metadata. Runs flush pending traces before they finish, so nothing is lost when a Worker is
suspended or a CLI exits. Tracing is off by default because traces carry prompts and learner data to LangSmith.

### Switching to Muse Spark (Meta Model API)

Only `.env` changes, not code. Set `MODEL_BASE_URL` and `MODEL_API_KEY` to Meta's values and set
`REASONING_MODEL` / `FAST_MODEL` to `muse-spark-1.3`. If the provider rejects `response_format`,
set `STRUCTURED_OUTPUT_METHOD=functionCalling`.

### Local performance note

Muse Glimmer reasons before answering (`reasoning_content`), at roughly 3–4 tok/s on this machine. A full
`npm start` therefore takes several minutes (run a single scenario while iterating), and a single Reflection
call has taken over 30 minutes. The local server's `--ctx-size 4096` is also tight, so keep prompts and tool
outputs compact.

Each model call times out after `MODEL_TIMEOUT_MS` (default 10 minutes) and is retried `MODEL_MAX_RETRIES`
times (default 1), so a stuck call fails with an error instead of hanging. Raise the timeout in `.env` if
long Reflection calls fail on your machine.
