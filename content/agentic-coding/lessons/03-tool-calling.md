# Tool Calling

Tool calling is the standard way for an agent to act. Instead of describing an action in prose, the model emits a structured request that the harness can execute.

## Describing tools

With each request you send the model a list of tool definitions. Each has:

- a **name**, such as `query_hypergraph`;
- a **description** of when to use it, which the model reads to decide;
- a **JSON schema** for its arguments.

The model never sees your tool's code, only this description. Clear names and descriptions matter more than clever implementations.

## The call

When the model wants a tool, it answers with a **tool call**: the tool's name, JSON arguments, and an id. It does not run the tool and it does not know the result yet.

## Returning the result

The harness runs the tool and sends the result back as a **tool message** carrying the same call id, so the model can match result to request. Then the model is called again and decides what to do next: call another tool or answer.

## Validate arguments

Models sometimes produce malformed or out-of-range arguments. Validate them against the schema before executing, and return a clear error as the tool result if they are wrong. The model can read that error and try again.

```quiz
[
  {
    "id": "tool-calling-q1",
    "prompt": "What does the model output when it wants to use a tool?",
    "options": [
      { "text": "A structured tool call: the tool's name and JSON arguments.", "correct": true },
      { "text": "The finished result of running the tool.", "reveals_gap_in": "agent-loop", "misconception": "model-executes-actions" },
      { "text": "A paragraph describing what it would like to do." },
      { "text": "A new system prompt." }
    ]
  },
  {
    "id": "tool-calling-q2",
    "prompt": "How does the model know a tool exists and how to call it?",
    "options": [
      { "text": "It searches the internet for available tools." },
      { "text": "It is retrained for every new tool." },
      { "text": "It reads the tool's source code.", "misconception": "model-reads-tool-code" },
      { "text": "Tool definitions (name, description, argument schema) are sent with the request.", "correct": true }
    ]
  },
  {
    "id": "tool-calling-q3",
    "prompt": "What happens after the harness runs a tool?",
    "options": [
      { "text": "The loop ends; the tool result is the final answer.", "reveals_gap_in": "agent-loop", "misconception": "loop-ends-after-action" },
      { "text": "The result is discarded unless it is an error." },
      { "text": "The result goes back as a tool message with the same call id, and the model is called again.", "correct": true },
      { "text": "The harness rewrites the model's previous message to include the result." }
    ]
  },
  {
    "id": "tool-calling-q4",
    "prompt": "Why validate tool arguments before running the tool?",
    "options": [
      { "text": "Validation makes the model faster." },
      { "text": "The loop already guarantees the arguments are correct, so it is optional.", "reveals_gap_in": "agent-loop" },
      { "text": "Schemas are only documentation." },
      { "text": "The model can produce malformed arguments; catching them prevents errors and unsafe actions.", "correct": true }
    ]
  },
  {
    "type": "schema_completion",
    "id": "tool-calling-q5",
    "prompt": "A learner asks for the weather in Paris. Write the JSON tool call the model emits for a tool named `get_weather` that takes one argument, `city`.",
    "example": "{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}",
    "checks": [
      { "path": "name", "rule": {"equals": "get_weather"} },
      { "path": "arguments.city", "rule": {"equals": "Paris"} },
      { "path": "result", "rule": {"absent": true}, "reveals_gap_in": "agent-loop", "misconception": "model-executes-actions" }
    ]
  },
  {
    "type": "matching",
    "id": "tool-calling-q6",
    "prompt": "Match each part of tool calling to what it is.",
    "left": ["Tool definition", "Tool call", "Tool message"],
    "right": ["Name, description and argument schema, sent with the request", "The model's request: tool name, JSON arguments and an id", "The result, sent back with the same call id"],
    "wrong_pairs": [
      { "left": 1, "right": 2, "reveals_gap_in": "agent-loop", "misconception": "model-executes-actions" },
      { "left": 0, "right": 1, "misconception": "model-reads-tool-code" }
    ]
  }
]
```
