# Structured Output

Free text is fine for people but hard for programs. When your code needs to act on a model's answer, ask for **structured output**: JSON that matches a schema you define.

## Asking for a schema

Most APIs let you attach a JSON schema to the request (often called *JSON schema mode* or *response format*). Others reuse tool calling: you define one "tool" whose arguments are the shape you want. Either way, the model is steered to produce matching JSON.

## Strict mode and missing values

Strict schema modes usually require **every field to be present**. To express "this may have no value", keep the field required and make it **nullable**, rather than optional.

## Always validate

Steering is not a guarantee. The model is still predicting tokens, so it can produce invalid JSON, a wrong type, or a value outside an enum. Parse and validate every response with a library such as Zod before your code trusts it. Validation gives you two things: a runtime check, and a typed object to work with.

## When validation fails

Never use an invalid response anyway. Retry, possibly including the validation error in the prompt, or fall back to a safe default. Silently patching the data hides bugs.

```quiz
[
  {
    "id": "structured-output-q1",
    "prompt": "Why use structured output instead of free text?",
    "options": [
      { "text": "It makes answers more creative." },
      { "text": "So your code can parse and act on the answer reliably.", "correct": true },
      { "text": "It removes the need for a prompt." },
      { "text": "Because models can only produce JSON.", "reveals_gap_in": "llm-basics" }
    ]
  },
  {
    "id": "structured-output-q2",
    "prompt": "In a strict JSON-schema mode, how should you express a field that may have no value?",
    "options": [
      { "text": "Leave it out of the schema." },
      { "text": "Mark it optional." },
      { "text": "Keep it required, but make it nullable.", "correct": true },
      { "text": "Always send an empty string." }
    ]
  },
  {
    "id": "structured-output-q3",
    "prompt": "The model returns JSON that fails validation. What should your code do?",
    "options": [
      { "text": "Use it anyway; the schema was in the request, so it must be right.", "reveals_gap_in": "llm-basics" },
      { "text": "Reject it and retry or fall back; never trust unvalidated output.", "correct": true },
      { "text": "Fill the missing fields with defaults and continue." },
      { "text": "Raise the temperature and use whatever comes back." }
    ]
  },
  {
    "id": "structured-output-q4",
    "prompt": "What does a validation library like Zod give you?",
    "options": [
      { "text": "It forces the model to follow the schema while generating." },
      { "text": "It compresses the JSON." },
      { "text": "It replaces the system prompt." },
      { "text": "A runtime check of the data and a typed result.", "correct": true }
    ]
  }
]
```
