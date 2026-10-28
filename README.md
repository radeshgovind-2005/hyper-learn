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
npm start
```

### Switching to Muse Spark (Meta Model API)

Only `.env` changes, not code. Set `MODEL_BASE_URL` and `MODEL_API_KEY` to Meta's values and set
`REASONING_MODEL` / `FAST_MODEL` to `muse-spark-1.3`. If the provider rejects `response_format`,
set `STRUCTURED_OUTPUT_METHOD=functionCalling`.

### Local performance note

Muse Glimmer reasons before answering (`reasoning_content`), at roughly 3–4 tok/s on this machine. A full
`npm start` therefore takes several minutes, and the local server's `--ctx-size 4096` is tight, so keep
prompts and tool outputs compact.
