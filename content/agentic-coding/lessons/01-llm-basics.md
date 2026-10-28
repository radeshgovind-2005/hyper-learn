# LLM Basics

A large language model (LLM) generates text one **token** at a time. A token is a chunk of text, often part of a word. At each step the model looks at every token so far and produces a probability for every possible next token. One token is picked, appended, and the process repeats. That is all generation is: repeated next-token prediction.

## Chat messages

Chat models take a list of **messages**, each with a role:

- **system**: instructions that shape the model's behaviour ("You are a helpful tutor…").
- **user**: what the person asked.
- **assistant**: what the model said earlier.

The model continues the conversation by writing the next assistant message.

## The context window

The model can only consider a limited number of tokens at once: its **context window**. The prompt *and* the generated answer must both fit. Anything outside the window simply does not exist for the model.

## The API is stateless

The model keeps no memory between calls. If you want it to remember the conversation, your program must send the whole history again with every request. "Memory" in an LLM app is always something your code provides.

## Temperature

**Temperature** controls how the next token is picked. At 0 the model almost always picks the most likely token, so output is close to deterministic. Higher values sample more freely, giving more varied text and more mistakes.

```quiz
[
  {
    "id": "llm-basics-q1",
    "prompt": "What does an LLM do at each step of generating text?",
    "options": [
      { "text": "It looks the answer up in a database of facts." },
      { "text": "It predicts a probability for every possible next token and picks one.", "correct": true },
      { "text": "It runs code to compute the answer." },
      { "text": "It copies the most similar sentence from its training data." }
    ]
  },
  {
    "id": "llm-basics-q2",
    "prompt": "What is the context window?",
    "options": [
      { "text": "The part of the screen where the chat is shown." },
      { "text": "How long the model remembers a user between sessions." },
      { "text": "The number of past conversations stored on the server." },
      { "text": "The maximum number of tokens the model can consider in one call, prompt and answer together.", "correct": true }
    ]
  },
  {
    "id": "llm-basics-q3",
    "prompt": "Why does a chat app send the whole conversation with every request?",
    "options": [
      { "text": "The API is stateless: the model keeps no memory between calls.", "correct": true },
      { "text": "To make the model answer faster." },
      { "text": "Because the server deletes messages after an hour." },
      { "text": "It doesn't; the model stores the conversation itself." }
    ]
  },
  {
    "id": "llm-basics-q4",
    "prompt": "What does setting temperature to 0 do?",
    "options": [
      { "text": "Makes the model refuse to answer." },
      { "text": "Shortens the answer." },
      { "text": "Makes output close to deterministic by picking the most likely tokens.", "correct": true },
      { "text": "Turns off the context window." }
    ]
  }
]
```
