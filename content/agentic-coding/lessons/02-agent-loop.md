# The Agent Loop

A single model call answers once. An **agent** keeps going: it decides on an action, the action runs, the agent looks at the result, and it decides again. It stops when it judges the task is done.

```
decide → act → observe → decide → … → done
```

## The harness does the acting

The model cannot run anything by itself; it only produces text. The program around it, the **harness**, reads what the model chose, carries out the action (search, run a command, call an API) and reports back.

## Observing the result

After an action, the harness appends the result to the message list and calls the model again. Because the API is stateless, this growing message list *is* the agent's memory of what it has done so far.

## Stopping

An agent stops when the model answers without asking for another action. That is not guaranteed to happen: a confused model can loop forever, repeating the same failing step. Every agent loop therefore needs a guard, such as a maximum number of iterations or a time budget, that ends the run no matter what the model does.

## Why loops are powerful

The loop lets a model correct course. If a step fails, the error message becomes part of the context, and the next decision can account for it. Most of what makes agents useful comes from this cycle, not from a bigger model.

```quiz
[
  {
    "id": "agent-loop-q1",
    "prompt": "What makes an agent different from a single LLM call?",
    "options": [
      { "text": "It uses a bigger model." },
      { "text": "It remembers earlier conversations automatically between API calls.", "reveals_gap_in": "llm-basics" },
      { "text": "It runs in a loop, choosing actions and seeing their results until the task is done.", "correct": true },
      { "text": "It doesn't need a system prompt." }
    ]
  },
  {
    "id": "agent-loop-q2",
    "prompt": "Who actually carries out an action the model chooses?",
    "options": [
      { "text": "The program around the model, often called the harness.", "correct": true },
      { "text": "The model runs it inside its own weights.", "reveals_gap_in": "llm-basics" },
      { "text": "The API provider runs any code the model writes." },
      { "text": "The user always has to type it in." }
    ]
  },
  {
    "id": "agent-loop-q3",
    "prompt": "Why does an agent loop need a maximum number of iterations?",
    "options": [
      { "text": "Models can only be called three times in a row." },
      { "text": "To make the answers more creative." },
      { "text": "Each call permanently uses up part of the model's memory.", "reveals_gap_in": "llm-basics" },
      { "text": "The model might never decide it is done, so the loop could run forever.", "correct": true }
    ]
  },
  {
    "id": "agent-loop-q4",
    "prompt": "How does the agent find out what its last action did?",
    "options": [
      { "text": "It doesn't; it guesses whether the action worked." },
      { "text": "The result is appended to the messages for the next model call.", "correct": true },
      { "text": "The result is written into the model's weights.", "reveals_gap_in": "llm-basics" },
      { "text": "It only sees the final answer at the end." }
    ]
  }
]
```
