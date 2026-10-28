# hyper-learn

Backend for **HyperLearn**, an adaptive learning platform built on a self-correcting hypergraph
(nodes = docs/exercises, edges = prerequisites). Built with LangGraph.js, LangChain.js and Zod.

## Architecture

```
            ┌──────────── supervisor ────────────┐
            ▼                                    ▼
   assistant ⇄ tools                    curator → reflection
            │                              ▲          │
            ▼                              └─ reject ─┤
           END                                        ▼ approve / max attempts
                                                     END
```

- **Supervisor** routes on `input_type`: `cron` goes to the Curator, `user_question` goes to the Assistant.
- **Curator** (high autonomy) reads performance data and proposes exactly one Zod-validated mutation.
- **Reflection** reviews each proposal. A rejected proposal goes back to the Curator, which gets the critique. The loop allows at most 2 attempts.
- **Reflection runs code checks first** (ids exist, target set correctly, no cycles or duplicate edges). An invalid proposal is rejected instantly, without a model call.
- **Learner Assistant** (low autonomy) calls `query_hypergraph`, `read_lesson`, `generate_diagram` and `navigate_ui` through a `ToolNode` loop.

| Path | Purpose |
| --- | --- |
| `content/agentic-coding/` | The course: `course.json` plus one Markdown lesson per file, each ending in a quiz |
| `src/course/` | Course schemas, loader, validation and graph helpers |
| `src/simulation/` | Seeded learner simulation and the evaluation scenarios |
| `src/analytics/` | Turns quiz attempts into per-lesson performance data |
| `src/eval/` | Rule-based reference Curator, scoring and the `npm run eval` runner |
| `src/mutations.ts` | Code checks a mutation must pass before Reflection |
| `src/index.ts` | Demo runner |
| `src/graph.ts` | Graph wiring and conditional edges |
| `src/state.ts` | State annotation and Zod schemas |
| `src/models.ts` | `getModel()` / `getStructuredModel()` factory |
| `src/nodes/*` | Supervisor, Assistant, Curator, Reflection |
| `src/tools/index.ts` | Assistant tools over the course, and the tool registry |
| `src/config/agents.json` | Agent definitions: role, goal, instructions, model, tools… |
| `src/agents.ts` | Validates `agents.json` and assembles each system prompt |

## Setup

```bash
npm install
cp .env.example .env   # points at the local llama.cpp server on :9931 by default
npm run typecheck
npm test               # all deterministic tests: no model server needed, a few seconds
npm start              # demos against the real model
npm run eval           # score the agents on the simulated scenarios
```

## The course

`content/agentic-coding/` holds a 6-lesson course on agentic coding:

```
llm-basics → agent-loop → tool-calling ─┐
llm-basics → structured-output ─────────┴→ multi-agent → reflection
```

`course.json` lists each lesson's id, title, summary, file and prerequisites. Each lesson is a Markdown file
ending in a fenced `quiz` block of multiple-choice questions. A wrong option can carry
`reveals_gap_in: "<lesson-id>"`: the earlier lesson a learner who picks it probably missed. Untagged wrong
options are gaps in the lesson itself.

The loader validates the course on startup: unknown fields, unknown or cyclic prerequisites, questions without
exactly one correct option, and tags that don't point at a real prerequisite all fail. It also requires every
direct prerequisite to be tagged on at least one wrong option, so a missing prerequisite always shows up in
the data.

## Evaluating the Curator

The evaluation answers one question: **does the Curator find and fix a planted fault?**

1. **Plant a fault.** A scenario publishes a broken copy of the course's prerequisite graph, or makes a lesson too hard.
2. **Simulate learners.** 300 seeded learners take lessons in an order the *published* graph allows. They can only
   master a lesson if they mastered its *true* prerequisites, and their wrong answers tend to reveal the real gap.
3. **Analyse in code.** Each lesson gets a fail rate, a 95% confidence interval, a `low_sample` flag and its top
   misconceptions (which lesson its wrong answers point to).
4. **Run the agents** (Curator → code checks → Reflection) and score the result against the known fix.

Everything except the model is deterministic: the same seed always produces the same data.

| Scenario | Planted fault | Correct fix |
| --- | --- | --- |
| `control` | Nothing | `flag_for_review` |
| `missing-prereq` | multi-agent no longer requires tool-calling | `add_prerequisite(multi-agent ← tool-calling)` |
| `overloaded` | agent-loop is too hard; its dependents fail too, so the highest fail rate isn't the cause | `split_node(agent-loop)` |
| `low-sample-trap` | missing-prereq, plus a 10-attempt lesson with a 90% fail rate | `add_prerequisite(multi-agent ← tool-calling)` |

A **rule-based reference Curator** (`src/eval/reference.ts`) must solve every scenario; the tests check it on 21
seeds each. If it couldn't, the data wouldn't contain the fault and the scenario, not the agent, would be broken.

```bash
npm run eval -- --reference-only        # instant: data tables and the reference's answers
npm run eval -- missing-prereq          # one scenario, with the agents
npm run eval                            # everything (slow on a local model)
```

Scores: `exact` (the planted fault's fix), `right_lesson` (right lesson, wrong action or target), `miss`.
The report shows both what would be applied (only if Reflection approved) and the Curator's last proposal,
which separates Curator mistakes from Reflection mistakes. Each run writes `reports/eval-<timestamp>.json`
after every scenario, so a long run that is cut off keeps its finished results.

The Curator's instructions describe the same root-cause procedure the reference follows, so the evaluation
measures whether the model applies that reasoning to the numbers correctly, not whether it invents it.

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

`npm test` covers the course loader, simulation, analytics, code checks and reference Curator. `src/agents.test.ts` covers config validation and prompt assembly. `src/graph.test.ts` builds the graph with scripted fake models (`buildGraph({ curator, reflection, assistant })`)
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
