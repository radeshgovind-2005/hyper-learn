# Reflection and Self-Correction

Agents make mistakes. A **reflection** step adds a reviewer: a second agent that checks a proposal against explicit criteria, then either approves it or sends it back with a critique.

## Explicit checks

"Is this good?" invites a vague yes. Give the reviewer named checks, such as *Is the target right? Does the action fit the evidence? Do the numbers match the data?*, and ask for a PASS or FAIL with evidence for each. The critique becomes specific and actionable.

## Feeding the critique back

The critique is stored in shared state, and the proposer's next prompt includes it along with the rejected proposal. The proposer has no memory of its own; it only knows what the prompt tells it.

## Bounding the loop

Reviewer and proposer may never agree. Cap the number of attempts so the loop always ends, and decide in advance what happens when the cap is reached: usually, apply nothing.

## Code first, judgement second

Many checks need no model at all: does the id exist, is a required field present, would this edge create a cycle? Run these in code first. They are instant and exact, and the reviewer model is then only asked about things that really need judgement.

## The shared-model problem

If proposer and reviewer are the same model, they share the same blind spots. Using a different model, or a different framing for the reviewer, reduces that risk.

```quiz
[
  {
    "id": "reflection-q1",
    "prompt": "What does a reflection step do?",
    "options": [
      { "text": "The same agent repeats its answer twice." },
      { "text": "A reviewer checks a proposal against explicit criteria and approves it or sends it back with a critique.", "correct": true },
      { "text": "The supervisor reroutes the work to a random agent.", "reveals_gap_in": "multi-agent" },
      { "text": "It lowers the temperature." }
    ]
  },
  {
    "id": "reflection-q2",
    "prompt": "Why cap the number of reflection attempts?",
    "options": [
      { "text": "Shared state can only hold two proposals.", "reveals_gap_in": "multi-agent" },
      { "text": "Models refuse to answer after two attempts." },
      { "text": "Proposer and reviewer may never agree; a cap guarantees the loop ends.", "correct": true },
      { "text": "There is no reason; retries are free." }
    ]
  },
  {
    "id": "reflection-q3",
    "prompt": "Why run code checks before the reviewer model?",
    "options": [
      { "text": "Code checks replace the reviewer completely." },
      { "text": "LLMs cannot read JSON.", "reveals_gap_in": "structured-output" },
      { "text": "Code checks make the model smarter." },
      { "text": "They catch invalid proposals instantly and exactly, so the model only judges what needs judgement.", "correct": true }
    ]
  },
  {
    "id": "reflection-q4",
    "prompt": "How does the critique reach the proposer on its next attempt?",
    "options": [
      { "text": "It is stored in shared state and included in the proposer's next prompt.", "correct": true },
      { "text": "Each agent keeps private memory that the others can read.", "reveals_gap_in": "multi-agent" },
      { "text": "The proposer remembers it automatically between calls." },
      { "text": "The reviewer edits the proposer's tools." }
    ]
  }
]
```
