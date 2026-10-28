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
- **Learner Assistant** (low autonomy) calls `query_hypergraph`, `generate_diagram` and `navigate_ui` through a `ToolNode` loop.

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Runner — executes both demo scenarios |
| `src/graph.ts` | Graph wiring and conditional edges |
| `src/state.ts` | State annotation, Zod schemas, `getPrompt()` |
| `src/models.ts` | `getModel()` / `getStructuredModel()` factory |
| `src/nodes/*` | Supervisor, Assistant, Curator, Reflection |
| `src/tools/index.ts` | Tool definitions over a mock hypergraph |
| `src/config/prompts.json` | All system prompts |

## Setup

```bash
npm install
cp .env.example .env   # points at the local llama.cpp server on :9931 by default
npm run typecheck
npm test               # deterministic graph tests with fake models (no server needed, ~1s)
npm start              # demo scenarios against the real model
```

### Tests

`src/graph.test.ts` builds the graph with scripted fake models (`buildGraph({ curator, reflection, assistant })`)
and checks the routing, not the model's judgement:

- an approved proposal ends after one round
- a rejection loops back to the Curator, whose retry prompt carries the critique and the rejected proposal
- the loop gives up after `MAX_CURATOR_ATTEMPTS` rejections
- the Assistant runs a requested tool and loops back to answer

This is the reliable way to exercise the reject → retry path. Whether a real model rejects anything depends on its judgement.

### Demo scenarios

`npm start` runs every scenario in order. Pass one or more scenario ids to run only those:

```bash
npm start -- assistant                    # one scenario
npm start -- curator curator-ambiguous    # several, in the order given in src/index.ts
```

| Id | Flow | What it shows |
| --- | --- | --- |
| `assistant` | supervisor → assistant ⇄ tools | A learner question answered with `query_hypergraph`, `generate_diagram` and `navigate_ui` |
| `curator` | supervisor → curator → reflection | Clear signal (Closures at a 72% fail rate); usually approved on the first attempt |
| `curator-ambiguous` | supervisor → curator ⇄ reflection | Two traps: a 12-attempt outlier and an upstream root cause (Functions). Makes a rejection more likely but doesn't guarantee one: Muse Glimmer has avoided both traps. Use `npm test` to exercise the retry path |

An unknown id fails with the list of valid ones. Scenarios live in the `SCENARIOS` array in `src/index.ts`.

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
