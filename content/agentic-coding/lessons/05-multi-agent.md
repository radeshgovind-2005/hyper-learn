# Multi-Agent Orchestration

One agent with every tool and every instruction gets confused. Splitting the work across **specialised agents**, each with its own prompt, tools and model, keeps each one focused.

## The supervisor

A **supervisor** decides which agent handles the current input and routes to it. When the decision is simple (a scheduled job versus a user question) make it plain code: it is faster, free and never wrong. Use an LLM to route only when the decision really needs judgement.

## Focused tool sets

Give each agent only the tools its job needs. Fewer, relevant tools make the model's tool choice more reliable, and they limit what each agent is able to do.

## Shared state

Agents communicate through **shared state**: a typed object every step can read and update. When one agent hands work to another, such as a proposal to review, it should write **structured output** validated against a schema, not free text the next agent has to interpret.

## Running tools in a graph

In a graph framework such as LangGraph, an agent's tool calls go to a **tool node**. The tool node executes them and routes the results back to the same agent, which then decides its next step.

## Trade-offs

Every extra agent adds model calls, latency and cost. Split only where the specialisation earns it.

```quiz
[
  {
    "id": "multi-agent-q1",
    "prompt": "What does a supervisor do in a multi-agent system?",
    "options": [
      { "text": "Runs every tool itself so the other agents don't have to.", "reveals_gap_in": "tool-calling", "misconception": "agent-runs-own-tools" },
      { "text": "Merges all agents into one large prompt." },
      { "text": "Decides which specialised agent should handle the current input and routes to it.", "correct": true },
      { "text": "Trains the other agents on new data." }
    ]
  },
  {
    "id": "multi-agent-q2",
    "prompt": "Why give each agent only the tools it needs?",
    "options": [
      { "text": "A tool can technically only be attached to one agent." },
      { "text": "Fewer, relevant tools make tool choice more reliable and limit what each agent can do.", "correct": true },
      { "text": "Each tool the model executes internally risks crashing it.", "reveals_gap_in": "tool-calling", "misconception": "agent-runs-own-tools" },
      { "text": "It makes no difference." }
    ]
  },
  {
    "id": "multi-agent-q3",
    "prompt": "How should one agent hand a proposal to another?",
    "options": [
      { "text": "As free text that the next agent interprets.", "reveals_gap_in": "structured-output", "misconception": "free-text-handoff" },
      { "text": "By editing the other agent's system prompt." },
      { "text": "It can't; agents never share data." },
      { "text": "As structured output validated against a schema and stored in shared state.", "correct": true }
    ]
  },
  {
    "id": "multi-agent-q4",
    "prompt": "In a LangGraph-style graph, what runs an agent's tool call?",
    "options": [
      { "text": "A tool node that executes the call and routes the result back to the agent.", "correct": true },
      { "text": "The supervisor, which then ends the graph.", "reveals_gap_in": "tool-calling", "misconception": "agent-runs-own-tools" },
      { "text": "The model provider's servers." },
      { "text": "Nothing; the tool call itself is the final answer." }
    ]
  }
]
```
